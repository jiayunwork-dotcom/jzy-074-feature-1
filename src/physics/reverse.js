/**
 * 按给定屏蔽目标反求最小厚度。
 *
 * 输入是「目标限值 + 各层材料及衰减系数 + 哪些层固定、哪些层可调」，
 * 输出是满足目标所需的最小厚度配置，并把该配置代回正向核算
 * （evaluateShielding——全服务唯一的一份正向公式）一并返回。
 *
 * 为什么不能把正向公式移项取对数交差：
 *  线性近似模式下宽束透射率
 *      T(y) = (1 + k·y) · e^{-y},   y = Σ μᵢxᵢ
 *  当 k > 1 时先增后减（薄处 (1+ky) 的增长压过指数衰减，T 甚至越过 1，
 *  正向核算会按非物理结果拒绝），对厚度不是单调对数关系，
 *  解析取对数会解到上升支上的假根。因此反解不做任何公式移项，
 *  只把正向核算当黑盒判据，在标量「附加总光学厚度」上做带界二分，
 *  且二分针对的是「从某个点开始一直可达标」的下降支：
 *  中段 T>1 的非物理区间一律视为尚未达标而跳过。
 *
 * 厚度分配：固定层不可动，其光学厚度先从需求中扣掉；
 * 附加光学深度只在可调层之间按权重（缺省均分）分配，
 * 每层加上去的厚度受该层可调上限约束。
 */
import { evaluateShielding } from './multilayer.js';
import { TargetUnreachableError } from './errors.js';

/**
 * 可调层未显式给 maxX 时的缺省上限：允许在现有厚度之上再加这么多
 * 「十值层」厚度（μ 越大允许的 x 越小，按光学厚度封顶才物理上合理）。
 */
const DEFAULT_MAX_EXTRA_TVL = 100;

/** 指数跨步找界的步数；每步光学厚度翻倍，足够覆盖任何合法限值。 */
const EXPAND_STEPS = 60;

/** 二分迭代次数：区间每次减半，80 次后剩余宽度 ~1e-24，远严于调用方的削薄容差。 */
const BISECT_STEPS = 80;

/**
 * @typedef {{
 *   material?: string, mu: number, x: number,
 *   adjustable?: boolean, maxX?: number, weight?: number,
 * }} ReverseLayer
 */

/**
 * 对「总光学深度 = baseOpticalDepth + added」的配置跑一次正向核算。
 * 固定层不动，附加光学深度按权重分给各可调层。
 * @returns {object|null} 正向核算结果；非物理（如线性 k>1 薄处 T>1）时返回 null
 */
function evaluateAtAdded(layers, adjustableIdx, weights, totalWeight, added, options) {
  const configured = layers.map((l) => ({ ...l }));
  for (const idx of adjustableIdx) {
    const share = added * (weights.get(idx) / totalWeight);
    configured[idx].x = layers[idx].x + share / layers[idx].mu;
  }
  const result = evaluateShielding(configured, options);
  // 非物理护栏（T>1 等）是正向核算的口径：这种厚度本就不允许当结果，
  // 反解把它视作「尚未达标」而不是候选解。
  if (
    !Number.isFinite(result.broadTransmission) ||
    result.broadTransmission < 0 ||
    result.broadTransmission > 1 + Number.EPSILON
  ) {
    return null;
  }
  return result;
}

/**
 * 反求满足目标所需的最小厚度配置。
 *
 * @param {ReverseLayer[]} layers 层结构（从源到探测器排序，最后一层为最外层）
 * @param {{
 *   target: { metric: 'broadTransmission'|'relativeDoseRate', limit: number },
 *   fluenceRate?: number,
 *   buildup?: {mode:'direct', value:number} | {mode:'linear', coefficient:number},
 * }} options
 * @returns {object} 反解厚度 + 代回正向核算的完整结果
 */
export function reverseSolve(layers, options) {
  const { target } = options;
  const limit = target.limit;

  // 拷贝一份再补 maxX，绝不改调用方（可能是已登记方案）的层对象。
  layers = layers.map((l) => ({ ...l }));

  const adjustableIdx = [];
  const weights = new Map();
  let totalWeight = 0;
  let baseOpticalDepth = 0;
  let maxAddedOpticalDepth = 0;

  layers.forEach((l, i) => {
    baseOpticalDepth += l.mu * l.x;
    if (l.adjustable) {
      const maxX = l.maxX ?? l.x + (DEFAULT_MAX_EXTRA_TVL * Math.LN10) / l.mu;
      const maxAdded = l.mu * (maxX - l.x);
      // 权重只用于分配，不改变可行性；非正权重的层不参与分配（只能保持原厚）。
      const w = l.weight ?? 1;
      const weight = Number.isFinite(w) && w > 0 ? w : 0;
      adjustableIdx.push(i);
      weights.set(i, weight);
      totalWeight += weight;
      maxAddedOpticalDepth += maxAdded;
      layers[i].maxX = maxX;
    }
  });

  const metricOf = (r) => (target.metric === 'relativeDoseRate' ? r.relativeDoseRate : r.broadTransmission);
  // 达标判据严格：正向核算给值必须真的 <= 限值。二分自然落到第一个
  // 让指标严格压到限值以内的浮点采样点；分配回各层厚度引入的 ULP 级
  // 舍入由末尾的 nextUp 护栏兜住，绝不交付「数值上还越限 1 ULP」的方案。
  const meets = (r) => r !== null && Number.isFinite(metricOf(r)) && metricOf(r) <= limit;

  // 零附加：现状已经达标，则最小厚度就是当前厚度（一层都不用加）。
  let atBase;
  try {
    atBase = evaluateAtAdded(
      layers, adjustableIdx, weights, totalWeight, 0, options,
    );
  } catch {
    // 现状本身落在非物理区间（如 direct B=2 薄处 T>1），继续在更厚处找下降支。
    atBase = null;
  }
  if (meets(atBase)) {
    return buildResult(layers, adjustableIdx, weights, totalWeight, 0, atBase, target);
  }

  // 所有可调层顶到上限的配置——可达性的最终判据。
  let atMax;
  try {
    atMax = evaluateAtAdded(
      layers, adjustableIdx, weights, totalWeight, maxAddedOpticalDepth, options,
    );
  } catch {
    atMax = null;
  }
  if (!meets(atMax)) {
    // 不许返回越限厚度，也不许返回 Infinity：明说在可调范围内压不到。
    throw new TargetUnreachableError({
      target,
      baseOpticalDepth,
      maxAddedOpticalDepth,
      bestAchievable: atMax === null ? null : metricOf(atMax),
      maxedLayers: adjustableIdx.map((i) => ({
        index: i,
        material: layers[i].material,
        mu: layers[i].mu,
        x: layers[i].maxX,
      })),
    });
  }

  // 找一个满足谓词「该点及以后一直可达标」的二分上界。
  // 指数跨步；中段非物理（线性 k>1 的驼峰 T>1）一律按未达标跳过，
  // 因此 hi 一旦达标，必然已经越过驼峰、落在单调下降支上。
  let lo = 0;
  let hi = 1e-8 * Math.max(1, baseOpticalDepth);
  for (let step = 0; step < EXPAND_STEPS; step++) {
    if (hi >= maxAddedOpticalDepth) {
      hi = maxAddedOpticalDepth;
      break;
    }
    let r;
    try {
      r = evaluateAtAdded(layers, adjustableIdx, weights, totalWeight, hi, options);
    } catch {
      r = null;
    }
    if (meets(r)) break;
    lo = hi;
    hi *= 2;
  }

  // 在 [lo, hi] 上二分：谓词 added ↦ 达标 在下降支上单调，
  // 返回的始终是经正向核算确认达标的右端点。
  for (let n = 0; n < BISECT_STEPS; n++) {
    const mid = (lo + hi) / 2;
    let r;
    try {
      r = evaluateAtAdded(layers, adjustableIdx, weights, totalWeight, mid, options);
    } catch {
      r = null;
    }
    if (meets(r)) hi = mid;
    else lo = mid;
  }

  // 用最终厚度再走一遍正向核算（round-trip 自洽的唯一口径）。
  let finalResult = evaluateAtAdded(
    layers, adjustableIdx, weights, totalWeight, hi, options,
  );
  let finalAdded = hi;

  // 理论上 hi 是达标的右端点；浮点分配回各层厚度可能引入 ULP 级偏差，
  // 真出现偏差就把附加光学厚度顶一格（nextUp）再确认，绝不交付越限结果。
  if (!meets(finalResult)) {
    finalAdded = Math.nextUp(finalAdded);
    finalResult = evaluateAtAdded(
      layers, adjustableIdx, weights, totalWeight, finalAdded, options,
    );
  }

  return buildResult(layers, adjustableIdx, weights, totalWeight, finalAdded, finalResult, target);
}

/** 组装反解响应：厚度配置 + 增量明细 + 代回正向核算的完整结果。 */
function buildResult(layers, adjustableIdx, weights, totalWeight, added, evaluation, target) {
  const adjustableSet = new Set(adjustableIdx);
  const layerResults = evaluation.layers.map((l, i) => ({
    index: l.index,
    material: l.material,
    mu: l.mu,
    x: l.x,
    opticalDepth: l.opticalDepth,
    adjustable: adjustableSet.has(i),
    ...(adjustableSet.has(i)
      ? {
          addedThickness: l.x - layers[i].x,
          weightShare: weights.get(i) / (totalWeight || 1),
          maxX: layers[i].maxX,
        }
      : { addedThickness: 0 }),
  }));

  return {
    target,
    reachable: true,
    targetMet:
      (target.metric === 'relativeDoseRate'
        ? evaluation.relativeDoseRate
        : evaluation.broadTransmission) <= target.limit,
    achieved: {
      narrowTransmission: evaluation.narrowTransmission,
      broadTransmission: evaluation.broadTransmission,
      relativeDoseRate: evaluation.relativeDoseRate,
      transmittedFluenceRate: evaluation.transmittedFluenceRate,
      metric:
        target.metric === 'relativeDoseRate'
          ? evaluation.relativeDoseRate
          : evaluation.broadTransmission,
    },
    totalOpticalDepth: evaluation.totalOpticalDepth,
    totalThickness: evaluation.totalThickness,
    addedOpticalDepth: added,
    addedThickness: layerResults.reduce((s, l) => s + l.addedThickness, 0),
    adjustableLayers: adjustableIdx,
    layers: layerResults,
    // 把这套厚度代回正向核算得到的完整结果——反解与正向对目标的判断必须一致。
    forward: evaluation,
  };
}
