/**
 * 按目标限值反求最小屏蔽厚度（反向核算）。
 *
 * 正向回答「给定厚度，透射率/剂量率是多少」；反解回答「给定一条
 * 不能越过的限值，最少要砌多厚」。防护设计的常态是先有限值再定厚度，
 * 本模块是这条反向路的唯一入口。
 *
 * 关键纪律：反解不允许另抄一套衰减公式。光学厚度 y = Σμᵢxᵢ 与
 * 透射率之间的换算一律走 multilayer.js 的 evaluateShielding()
 * （它又只调用 attenuation.js 里那一份指数公式），保证反解结果与
 * 正向核算口径一致、round-trip 自洽。
 *
 * 为什么不能「公式移项取对数」：
 *  - direct 模式 B 为常数时 T(y)=B·e⁻ʸ 尚可解析取对数；
 *  - linear 模式 T(y)=(1+k·y)·e⁻ʸ 是先增后减的组合（y 从 0 出发
 *    先随 1+ky 上升、随后被指数压下去），k>1 时小 y 区段 T 甚至 >1
 *    （被正向核算的物理护栏判为非物理）。对这种非单调关系直接解析
 *    求逆会取到错误的那一支。因此统一用「单调判定 + 括界 + 二分」
 *    数值求根，两种积累因子模式走同一条路。
 *
 * 多层且只有部分层允许加厚时：指标只取决于总光学厚度，先把不可动
 * 层与可调层的已有厚度贡献计入 y0，再在可调层之间按 μ 从大到小
 * 贪心分配增量（μ 越大，每单位光学厚度越省物理厚度，这给出最小的
 * 总附加物理厚度）；带 maxX 的层依次填满。
 *
 * 数值口径：二分把根夹到 1e-15 相对精度后，分配结果再无条件加一次
 * ~1e-12 相对量级的微量厚度，保证代回正向核算的指标严格落在限值
 * 内侧（而不是压线浮点上飘到另一侧）；该增量比「最小性」关心的
 * 任何可感知削薄（≥1e-9 相对）都低几个数量级，不影响最小性。
 */
import { evaluateShielding } from './multilayer.js';
import { UnphysicalResultError, TargetUnreachableError } from './errors.js';

/** 支持反求的目标指标；相对剂量率在数值上等于宽束透射率，两者是同一个量。 */
export const TARGET_METRICS = ['broadTransmission', 'relativeDoseRate'];

/** 二分区间宽度的相对收敛容差（再往下压只会被浮点舍入吞掉）。 */
const BISECTION_REL_TOLERANCE = 1e-15;
/** 二分内部判定「该点已可行」的相对容差。 */
const BISECTION_FEASIBLE_SLACK = 1e-14;
/** 分配后整体达标判定的相对容差（宽松，只兜病态边界）。 */
const FINAL_FEASIBLE_SLACK = 1e-12;
/** 定步数二分，避免 while 判等在浮点平台上不终止。 */
const BISECTION_ITERATIONS = 64;
/** 微调次数上限（每次增量加倍，防极端舍入死循环）。 */
const NUDGE_MAX_TRIES = 16;

/** 反解落定时向「更厚」侧加的微量光学厚度：严格落到限值内侧用。 */
function nudgeStep(requiredY, scale = 1) {
  return scale * Math.max(1e-12, 256 * Number.EPSILON * Math.max(1, requiredY));
}

/**
 * 用唯一的正向核算在虚拟单层（μ=1，厚度=y）上取目标指标。
 * 宽束透射率只由总光学厚度 y 与积累因子决定，与层数、各层 μ 无关，
 * 所以标量求根可以在这个虚拟层上进行；最终方案仍用真实层走一次
 * 完整的 evaluateShielding() 核验。
 */
function metricAtOpticalDepth(y, buildupSpec, metric) {
  const r = evaluateShielding([{ material: '__inverse_virtual__', mu: 1, x: y }], {
    buildup: buildupSpec,
  });
  return r[metric];
}

/**
 * 给定总光学厚度起点 y0，求满足 M(y) <= limit 的最小总光学厚度 y*。
 * 对 y >= y0 求根；y0 本身已达标（严格意义，只允许 1 ULP 舍入）时
 * 直接返回 y0（允许零增量）。
 *
 * 括界与二分全程只用 metricAtOpticalDepth（即正向核算）取值：
 *  - 非物理区段（如 linear 模式 k>1 时小 y 处 T>1）正向核算抛
 *    UnphysicalResultError，搜根时视为「尚未进入可行区」继续向右括；
 *  - 真正的下降支是单调的，进入后二分必然收敛到最小可行 y。
 *
 * @returns {{ required: number, baselineFeasible: boolean }}
 */
function solveRequiredOpticalDepth(y0, buildupSpec, metric, limit) {
  const valueAt = (y) => metricAtOpticalDepth(y, buildupSpec, metric);
  const strictlyFeasible = (v) => v <= limit + Number.EPSILON * Math.max(1, limit);
  const feasible = (v) => v <= limit * (1 + BISECTION_FEASIBLE_SLACK) + Number.EPSILON;

  // 起点已达标：不需要任何加厚（limit=1、剂量率上限很松等情形）。
  // 这里用严格判据：压线浮点上飘到限值另一侧的，仍交给求根+微调落定。
  try {
    if (strictlyFeasible(valueAt(y0))) return { required: y0, baselineFeasible: true };
  } catch (err) {
    if (!(err instanceof UnphysicalResultError)) throw err;
  }

  // 倍增括界：[y0, hi]，直到 hi 处可行（或越过有限性上限）。
  let hi = Math.max(y0, 1e-12);
  for (;;) {
    let vHi;
    try {
      vHi = valueAt(hi);
    } catch (err) {
      if (!(err instanceof UnphysicalResultError)) throw err;
      vHi = undefined; // 仍在非物理区段，继续向右。
    }
    if (vHi !== undefined && feasible(vHi)) break;
    if (hi > 1e100) {
      throw new TargetUnreachableError('在可达厚度范围内无法把指标压到目标限值以下', {
        metric,
        limit,
        requiredOpticalDepth: null,
      });
    }
    hi *= 2;
  }

  // 二分（定步）。mid 处非物理说明可行根在 mid 右侧；否则按指标取值收缩。
  let lo = y0;
  for (let i = 0; i < BISECTION_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    if (hi - lo <= BISECTION_REL_TOLERANCE * Math.max(1, hi)) break;
    let vMid;
    try {
      vMid = valueAt(mid);
    } catch (err) {
      if (!(err instanceof UnphysicalResultError)) throw err;
      lo = mid;
      continue;
    }
    if (feasible(vMid)) hi = mid;
    else lo = mid;
  }
  return { required: hi, baselineFeasible: false };
}

/**
 * 在可调层之间分配总光学厚度增量，最小化总附加物理厚度。
 * μ 越大的层每单位物理厚度提供越多光学厚度，故按 μ 降序依次填满。
 *
 * @param {object[]} layers 归一化后的层（含 mu, x, adjustable, maxX?）
 * @param {number} requiredY 要求达到的总光学厚度
 * @returns {object[]} 分配好 x 的新层数组（不改入参）
 */
function allocateThickness(layers, requiredY) {
  const result = layers.map((l) => ({ ...l }));
  let y = result.reduce((s, l) => s + l.mu * l.x, 0);
  if (y >= requiredY) return result;

  // μ 降序；并列时按层序，保证分配确定。
  const order = result
    .map((l, index) => ({ l, index }))
    .filter(({ l }) => l.adjustable)
    .sort((a, b) => b.l.mu - a.l.mu || a.index - b.index);

  let need = requiredY - y;
  for (const { l } of order) {
    if (need <= 0) break;
    const roomY = l.maxX === Infinity ? Infinity : Math.max(0, (l.maxX - l.x) * l.mu);
    const addY = Math.min(need, roomY);
    if (addY > 0) {
      l.x = Math.min(l.maxX, l.x + addY / l.mu);
      need -= addY;
    }
  }
  return result;
}

/** 顶到上限的配置：可调层一律取 maxX。 */
function cappedLayers(layers) {
  return layers.map((l) =>
    l.adjustable ? { ...l, x: l.maxX } : { ...l },
  );
}

/**
 * 找一个仍有余量且最省物理厚度（μ 最大）的可调层，给它加上
 * 极小光学厚度增量；所有可调层都已顶到上限时返回 null。
 */
function nudgeLayers(layers, deltaY) {
  const candidate = layers
    .map((l, index) => ({ l, index }))
    .filter(({ l }) =>
      l.adjustable &&
      (l.maxX === Infinity || l.x < l.maxX - 1e-15 * Math.max(1, l.maxX)))
    .sort((a, b) => b.l.mu - a.l.mu || a.index - b.index)[0];
  if (!candidate) return null;
  return layers.map((l, i) =>
    i === candidate.index ? { ...l, x: Math.min(l.maxX, l.x + deltaY / l.mu) } : l,
  );
}

/**
 * 反求最小厚度。
 *
 * @param {Array<{material?:string, mu:number, x:number, adjustable?:boolean, maxX?:number}>} layers
 *   全部层（源→探测器，最后一层为最外层）；可调层标 adjustable:true，
 *   可选 maxX 给出该层允许的最大厚度（缺省不封顶）。
 * @param {{
 *   metric: 'broadTransmission'|'relativeDoseRate',
 *   limit: number,
 *   buildup?: {mode:'direct',value:number}|{mode:'linear',coefficient:number},
 *   fluenceRate?: number,
 * }} target
 * @returns {object} 反解厚度 + 把该厚度代回正向核算的完整结果
 */
export function solveInverseThickness(layers, target) {
  const { metric, limit } = target;
  const buildupSpec = target.buildup ?? { mode: 'direct', value: 1 };
  const fluenceRate = target.fluenceRate ?? 1;

  if (!layers.some((l) => l.adjustable)) {
    // 校验层本应拦住，双保险：没有可调层却又声称要反求是无意义请求。
    throw new TargetUnreachableError('没有允许加厚的层，无法反求厚度', {
      metric,
      limit,
    });
  }

  // 先算所有可调层都顶到上限时能不能达标（全不封顶时渐近值为 0，必可达）。
  const capped = cappedLayers(layers);
  const cappedY = capped.reduce((s, l) => s + l.mu * l.x, 0);
  const baselineY = layers.reduce((s, l) => s + l.mu * l.x, 0);
  const allBounded = layers.every((l) => !l.adjustable || l.maxX !== Infinity);
  if (allBounded && cappedY > baselineY) {
    let rCap;
    try {
      rCap = evaluateShielding(capped, { buildup: buildupSpec, fluenceRate });
    } catch (err) {
      // 封顶配置落在非物理区（如 linear 模式小光学厚度处 T>1）：
      // 允许加厚的范围内根本进不了可行区，同样按无法达标回报，
      // 而不是把 422 UNPHYSICAL_RESULT 漏给调用方。
      if (!(err instanceof UnphysicalResultError)) throw err;
      throw new TargetUnreachableError(
        '所有允许加厚的层都加到厚度上限后，指标仍不满足目标限值，无法达标',
        {
          metric,
          limit,
          achieved: null,
          cappedTransmissionUnphysical: true,
          baselineOpticalDepth: baselineY,
          maxOpticalDepth: cappedY,
        },
      );
    }
    const capTol = FINAL_FEASIBLE_SLACK * Math.max(1, limit);
    if (rCap[metric] > limit + capTol) {
      throw new TargetUnreachableError(
        '所有允许加厚的层都加到厚度上限后，指标仍高于目标限值，无法达标',
        {
          metric,
          limit,
          achieved: rCap[metric],
          baselineOpticalDepth: baselineY,
          maxOpticalDepth: cappedY,
        },
      );
    }
  }

  // 标量求根：满足限值所需的最小总光学厚度（正向公式的唯一出口）。
  const { required: requiredY, baselineFeasible } = solveRequiredOpticalDepth(
    baselineY,
    buildupSpec,
    metric,
    limit,
  );

  // 在可调层间贪心分配增量，先扣固定层贡献。
  let solved = allocateThickness(layers, requiredY);
  let forward = evaluateShielding(solved, { buildup: buildupSpec, fluenceRate });

  if (!baselineFeasible) {
    // 无条件向「更厚」侧加一次微量：求根与分配的舍入可能让指标压线
    // 浮点上飘到限值另一侧，这一步保证严格落在限值内侧。增量 ~1e-12
    // 相对量级，远低于任何可感知的削薄，不影响最小性。
    const nudged = nudgeLayers(solved, nudgeStep(requiredY));
    if (nudged) {
      solved = nudged;
      forward = evaluateShielding(solved, { buildup: buildupSpec, fluenceRate });
    }
  }

  // 兜底：若代回正向核算后仍明显越限（病态边界、极端舍入），
  // 继续加倍微调；可调层全部顶到上限仍压不下去则明确报不可达。
  const finalSlack = () => limit * (1 + FINAL_FEASIBLE_SLACK) + Number.EPSILON;
  let nudges = 0;
  while (forward[metric] > finalSlack()) {
    if (nudges >= NUDGE_MAX_TRIES) {
      throw new TargetUnreachableError('已到可调范围上限，无法把指标压到限值以下', {
        metric,
        limit,
        achieved: forward[metric],
        requiredOpticalDepth: requiredY,
        maxOpticalDepth: cappedY,
      });
    }
    nudges += 1;
    const nudged = nudgeLayers(solved, nudgeStep(requiredY, 2 ** nudges));
    if (!nudged) {
      throw new TargetUnreachableError('已到可调范围上限，无法把指标压到限值以下', {
        metric,
        limit,
        achieved: forward[metric],
        requiredOpticalDepth: requiredY,
        maxOpticalDepth: cappedY,
      });
    }
    solved = nudged;
    forward = evaluateShielding(solved, { buildup: buildupSpec, fluenceRate });
  }

  const totalY = forward.totalOpticalDepth;
  return {
    feasible: true,
    target: { metric, limit },
    buildup: buildupSpec,
    achievedMetric: forward[metric],
    baselineFeasible,
    addedOpticalDepth: totalY - baselineY,
    totalOpticalDepth: totalY,
    // 代回正向核算的完整结果：调用方一眼看清方案确实压在限值以内。
    forward,
    layers: forward.layers.map((fl, i) => ({
      ...fl,
      adjustable: Boolean(solved[i].adjustable),
      maxX: solved[i].adjustable ? (layers[i].maxX ?? null) : null,
      initialX: layers[i].x,
      addedX: fl.x - layers[i].x,
    })),
  };
}
