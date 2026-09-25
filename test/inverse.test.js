/**
 * 反解（按目标限值反求最小厚度）物理测试。
 *
 * 钉死的承诺：
 *  1. round-trip 自洽：反解厚度代回正向核算，目标指标确实不超过限值；
 *  2. 最小性：把反解厚度再削掉一丁点就会越限，不是随手给的偏厚值；
 *  3. direct 与 linear 两种积累因子模式都成立，尤其 linear 模式
 *     透射率对厚度非单调时不能取错支；
 *  4. 多层部分层固定时，固定层贡献被扣除、增量只落在可调层上；
 *  5. 可调范围内压不到目标时明确报 TARGET_UNREACHABLE，不返回越限厚度；
 *  6. 反解全程复用 evaluateShielding()，不另抄衰减公式。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveInverseThickness } from '../src/physics/inverse.js';
import { evaluateShielding } from '../src/physics/multilayer.js';
import { TargetUnreachableError } from '../src/physics/errors.js';

const EPS = Number.EPSILON;

/** 用同一套正向核算重新评估反解方案（round-trip 必须走的就是这份公式）。 */
function reevaluate(solution, buildup, fluenceRate = 1) {
  const layers = solution.layers.map((l) => ({ material: l.material, mu: l.mu, x: l.x }));
  return evaluateShielding(layers, { buildup, fluenceRate });
}

/**
 * 最小性检查：把每个可调层的厚度削掉相对 1e-9 的一丁点，
 * 重新走正向核算后指标必须越过限值。
 */
function assertMinimal(solution, buildup, { metric, limit }, shave = 1e-9) {
  const shavedLayers = solution.layers.map((l) => {
    if (!l.adjustable || l.addedX <= 0) return { material: l.material, mu: l.mu, x: l.x };
    return { material: l.material, mu: l.mu, x: Math.max(l.initialX, l.x * (1 - shave)) };
  });
  const r = evaluateShielding(shavedLayers, { buildup });
  assert.ok(
    r[metric] > limit,
    `削薄后仍未越限：削薄后 ${metric}=${r[metric]}，限值=${limit}（反解厚度不是最小）`,
  );
}

test('direct 模式：反解厚度与解析解 -ln(limit/B)/μ 一致，round-trip 达标', () => {
  for (const [mu, B, limit] of [
    [2, 1, 0.1],
    [0.5, 2, 0.3],
    [1.3, 5, 0.01],
    [Math.PI, 1.7, 0.5],
  ]) {
    const buildup = { mode: 'direct', value: B };
    const sol = solveInverseThickness(
      [{ material: 'Pb', mu, x: 0, adjustable: true, maxX: Infinity }],
      { metric: 'broadTransmission', limit, buildup },
    );
    const expected = Math.log(B / limit) / mu;
    assert.ok(Math.abs(sol.layers[0].x - expected) <= 1e-9 * Math.max(1, expected),
      `mu=${mu},B=${B},limit=${limit}: 反解 ${sol.layers[0].x} vs 解析 ${expected}`);
    // round-trip：同一份正向核算确认压在限值以内。
    const back = reevaluate(sol, buildup);
    assert.ok(back.broadTransmission <= limit + EPS * 2, `round-trip 越限: ${back.broadTransmission}`);
    assert.equal(sol.achievedMetric, back.broadTransmission);
    assertMinimal(sol, buildup, { metric: 'broadTransmission', limit });
  }
});

test('B=1 时限值 0.5：反解厚度恰好是一个 HVL', () => {
  const mu = 0.577;
  const sol = solveInverseThickness(
    [{ material: 'Pb', mu, x: 0, adjustable: true, maxX: Infinity }],
    { metric: 'broadTransmission', limit: 0.5, buildup: { mode: 'direct', value: 1 } },
  );
  const hvl = Math.LN2 / mu;
  assert.ok(Math.abs(sol.layers[0].x - hvl) <= 1e-9 * hvl);
  assert.ok(Math.abs(sol.totalOpticalDepth - Math.LN2) <= 1e-9);
});

test('linear 模式（k≤1，单调）：反解同样成立且最小', () => {
  for (const [k, limit] of [[0.3, 0.2], [0.5, 0.01], [1, 0.5], [0.1, 1e-3]]) {
    const buildup = { mode: 'linear', coefficient: k };
    const sol = solveInverseThickness(
      [{ material: 'Pb', mu: 1, x: 0, adjustable: true, maxX: Infinity }],
      { metric: 'broadTransmission', limit, buildup },
    );
    const y = sol.totalOpticalDepth;
    // 反解光学厚度必须满足正向关系 (1+k·y)·e⁻ʸ ≈ limit（自洽，不重推公式）。
    const back = reevaluate(sol, buildup);
    assert.ok(Math.abs(back.broadTransmission - (1 + k * y) * Math.exp(-y)) <= 8 * EPS);
    assert.ok(back.broadTransmission <= limit + 2 * EPS, `limit=${limit} 越限`);
    assertMinimal(sol, buildup, { metric: 'broadTransmission', limit });
  }
});

test('linear 模式非单调（k>1）：不能取对数取到 T>1 的错误支，根在下降支', () => {
  const k = 2;
  const limit = 0.5;
  const buildup = { mode: 'linear', coefficient: k };
  // 朴素「取对数」会拿 e⁻ʸ=0.5 → y=ln2≈0.693，但那里 (1+2y)e⁻ʸ≈1.193>1，
  // 既非物理也不达标。f(y)=(1+ky)e⁻ʸ 的峰值在 y=(k-1)/k=0.5（f'(y)=0 解），
  // 正确的最小可行根在峰值之后的下降支上。
  const naive = Math.LN2;
  assert.ok((1 + k * naive) * Math.exp(-naive) > 1, '前提：朴素对数解确在错误支上');
  const peak = (k - 1) / k;
  // 峰值 f_peak = k·e^{-(k-1)/k}：k=2 时为 2/√e≈1.2131，确实大于 1（非物理区段存在）。
  assert.equal((1 + k * peak) * Math.exp(-peak), k * Math.exp(-peak));

  const sol = solveInverseThickness(
    [{ material: 'Pb', mu: 1, x: 0, adjustable: true, maxX: Infinity }],
    { metric: 'broadTransmission', limit, buildup },
  );
  const y = sol.totalOpticalDepth;
  assert.ok(y > peak, `反解必须越过峰值位置，实际 y=${y}`);
  assert.ok(Math.abs((1 + k * y) * Math.exp(-y) - limit) <= 1e-10);
  const back = reevaluate(sol, buildup);
  assert.ok(back.broadTransmission <= limit + 2 * EPS);
  assertMinimal(sol, buildup, { metric: 'broadTransmission', limit });
});

test('非单调情形扫描多个 k>1 与限值：全部取到下降支上的最小可行根', () => {
  for (const k of [1.5, 2, 3.5, 10]) {
    // f(y)=(1+ky)e⁻ʸ 的峰值位置 y=(k-1)/k（k→∞ 时趋近 1），
    // 峰值大小 f_peak=(1+k-1)e^{-(k-1)/k}=k·e^{-1+1/k}>1。
    const peak = (k - 1) / k;
    for (const limit of [0.9, 0.5, 0.1, 0.01]) {
      // 本组所有限值都小于各 k 的峰值，可行根一定在峰值之后的下降支。
      assert.ok(limit < k * Math.exp(-peak) + 1e-12,
        `前提：k=${k} 时 limit=${limit} 必须小于峰值 ${k * Math.exp(-peak)}`);
      const buildup = { mode: 'linear', coefficient: k };
      const sol = solveInverseThickness(
        [{ mu: 1, x: 0, adjustable: true, maxX: Infinity }],
        { metric: 'broadTransmission', limit, buildup },
      );
      const y = sol.totalOpticalDepth;
      assert.ok(y > peak, `k=${k},limit=${limit}: y=${y} 落在峰值左侧`);
      const back = reevaluate(sol, buildup);
      assert.ok(back.broadTransmission <= limit * (1 + 1e-11),
        `k=${k},limit=${limit}: round-trip ${back.broadTransmission} 越限`);
      assertMinimal(sol, buildup, { metric: 'broadTransmission', limit }, 1e-7);
    }
  }
});

test('限值=1：零厚度（或已有结构）即达标，增量为零', () => {
  const sol = solveInverseThickness(
    [{ material: 'Pb', mu: 1, x: 1, adjustable: true, maxX: Infinity }],
    { metric: 'broadTransmission', limit: 1, buildup: { mode: 'linear', coefficient: 0.5 } },
  );
  assert.equal(sol.baselineFeasible, true);
  assert.equal(sol.addedOpticalDepth, 0);
  assert.equal(sol.layers[0].addedX, 0);
  assert.equal(sol.achievedMetric, evaluateShielding([{ mu: 1, x: 1 }], {
    buildup: { mode: 'linear', coefficient: 0.5 },
  }).broadTransmission);
});

test('多层部分层固定：固定层贡献先扣除，增量只加在可调层上', () => {
  const buildup = { mode: 'direct', value: 1 };
  // 混凝土固定墙 μ=.5,x=4 → y=2；铅可调 μ=2。目标 0.01 → 总 y=ln100。
  const layers = [
    { material: 'concrete', mu: 0.5, x: 4, adjustable: false },
    { material: 'Pb', mu: 2, x: 0, adjustable: true, maxX: Infinity },
  ];
  const sol = solveInverseThickness(layers, { metric: 'broadTransmission', limit: 0.01, buildup });
  assert.equal(sol.layers[0].x, 4);           // 固定层厚度不动
  assert.equal(sol.layers[0].addedX, 0);
  const expectedPb = (2 * Math.LN10 - 2) / 2;
  assert.ok(Math.abs(sol.layers[1].x - expectedPb) <= 1e-10);
  assert.ok(Math.abs(sol.layers[1].addedX - expectedPb) <= 1e-10);
  assert.ok(Math.abs(sol.addedOpticalDepth - (2 * Math.LN10 - 2)) <= 1e-10);
  const back = reevaluate(sol, buildup);
  assert.ok(back.broadTransmission <= 0.01 + 1e-12);
  assertMinimal(sol, buildup, { metric: 'broadTransmission', limit: 0.01 });
});

test('多层：可调层有已建厚度时，只在已有厚度之上求增量', () => {
  const buildup = { mode: 'direct', value: 1 };
  const layers = [
    { material: 'concrete', mu: 0.5, x: 4, adjustable: false },   // y=2
    { material: 'Pb', mu: 2, x: 0.5, adjustable: true, maxX: Infinity }, // 已有 y=1
  ];
  const sol = solveInverseThickness(layers, { metric: 'broadTransmission', limit: 0.01, buildup });
  // 还需 y = ln100 - 3，铅增量 = (ln100-3)/2
  const expectedAdded = (2 * Math.LN10 - 3) / 2;
  assert.ok(Math.abs(sol.layers[1].addedX - expectedAdded) <= 1e-10);
  assert.ok(Math.abs(sol.layers[1].x - (0.5 + expectedAdded)) <= 1e-10);
  assertMinimal(sol, buildup, { metric: 'broadTransmission', limit: 0.01 });
});

test('多层贪心：增量优先给 μ 大（每单位光学厚度最省物理厚度）的可调层', () => {
  const buildup = { mode: 'direct', value: 1 };
  const layers = [
    { material: 'Pb', mu: 2, x: 0, adjustable: true, maxX: Infinity },
    { material: 'conc', mu: 0.5, x: 0, adjustable: true, maxX: Infinity },
  ];
  const sol = solveInverseThickness(layers, { metric: 'broadTransmission', limit: 0.5, buildup });
  assert.ok(Math.abs(sol.layers[0].x - Math.LN2 / 2) <= 1e-10);
  assert.equal(sol.layers[1].x, 0); // μ 小的层不该分到厚度
  assertMinimal(sol, buildup, { metric: 'broadTransmission', limit: 0.5 });
});

test('带 maxX：高 μ 层填满后，剩余增量溢出到下一可调层', () => {
  const buildup = { mode: 'direct', value: 1 };
  const layers = [
    { material: 'Pb', mu: 2, x: 0, adjustable: true, maxX: 0.1 },  // 最多贡献 y=.2
    { material: 'conc', mu: 0.5, x: 0, adjustable: true, maxX: Infinity },
  ];
  const sol = solveInverseThickness(layers, { metric: 'broadTransmission', limit: 0.5, buildup });
  assert.equal(sol.layers[0].x, 0.1);
  assert.ok(Math.abs(sol.layers[1].x - (Math.LN2 - 0.2) / 0.5) <= 1e-10);
  const back = reevaluate(sol, buildup);
  assert.ok(back.broadTransmission <= 0.5 + 2 * EPS);
  assertMinimal(sol, buildup, { metric: 'broadTransmission', limit: 0.5 });
});

test('可调层全部顶到上限仍不达标：报 TARGET_UNREACHABLE（422），不返回越限厚度', () => {
  const layers = [
    { material: 'Pb', mu: 2, x: 0, adjustable: true, maxX: 0.1 },   // y≤.2
    { material: 'conc', mu: 0.5, x: 0, adjustable: true, maxX: 0.9 }, // y≤.45 → 总≤.65<ln2
  ];
  assert.throws(
    () => solveInverseThickness(layers, {
      metric: 'broadTransmission',
      limit: 0.5,
      buildup: { mode: 'direct', value: 1 },
    }),
    (err) => {
      assert.ok(err instanceof TargetUnreachableError);
      assert.equal(err.statusCode, 422);
      assert.equal(err.code, 'TARGET_UNREACHABLE');
      assert.ok(err.details.achieved > 0.5);
      assert.equal(err.details.maxOpticalDepth, 0.65);
      return true;
    },
  );
});

test('固定层 + 唯一可调层封顶仍不够：固定层贡献计入后判不可达', () => {
  const layers = [
    { material: 'concrete', mu: 0.5, x: 0.2, adjustable: false }, // 固定 y=.1
    { material: 'Pb', mu: 1, x: 0, adjustable: true, maxX: 0.5 }, // 最多再 y=.5 → 总 .6
  ];
  assert.throws(
    () => solveInverseThickness(layers, {
      metric: 'broadTransmission',
      limit: 0.5,
      buildup: { mode: 'direct', value: 1 },
    }),
    (err) => err.code === 'TARGET_UNREACHABLE' && err.details.baselineOpticalDepth === 0.1
      && err.details.maxOpticalDepth === 0.6 && err.details.achieved > 0.5,
  );
});

test('非单调 + 封顶配置落在 T>1 的非物理区：同样明确报不可达，不漏 UNPHYSICAL', () => {
  assert.throws(
    () => solveInverseThickness(
      [{ mu: 1, x: 0, adjustable: true, maxX: 0.5 }],
      { metric: 'broadTransmission', limit: 0.5, buildup: { mode: 'linear', coefficient: 2 } },
    ),
    (err) => err.code === 'TARGET_UNREACHABLE' && err.details.cappedTransmissionUnphysical === true,
  );
});

test('非单调 + 封顶在下降支但仍不够：报不可达并给出封顶实际值', () => {
  // cap y=1.5 处 (1+3)e^-1.5≈0.893 > 0.5
  assert.throws(
    () => solveInverseThickness(
      [{ mu: 1, x: 0, adjustable: true, maxX: 1.5 }],
      { metric: 'broadTransmission', limit: 0.5, buildup: { mode: 'linear', coefficient: 2 } },
    ),
    (err) => err.code === 'TARGET_UNREACHABLE' && Math.abs(err.details.achieved - 4 * Math.exp(-1.5)) < 1e-12,
  );
});

test('relativeDoseRate 目标：数值上与宽束透射率同一口径，round-trip 达标', () => {
  const buildup = { mode: 'linear', coefficient: 0.4 };
  const sol = solveInverseThickness(
    [{ material: 'Pb', mu: 1, x: 0, adjustable: true, maxX: Infinity }],
    { metric: 'relativeDoseRate', limit: 0.05, buildup },
  );
  const back = reevaluate(sol, buildup);
  assert.equal(back.relativeDoseRate, back.broadTransmission);
  assert.ok(back.relativeDoseRate <= 0.05 + 2 * EPS);
  assertMinimal(sol, buildup, { metric: 'relativeDoseRate', limit: 0.05 });
});

test('剂量率上限大于 1（零厚度即达标）：零增量直接返回', () => {
  const sol = solveInverseThickness(
    [{ mu: 1, x: 0, adjustable: true, maxX: Infinity }],
    { metric: 'relativeDoseRate', limit: 5, buildup: { mode: 'direct', value: 1 } },
  );
  assert.equal(sol.baselineFeasible, true);
  assert.equal(sol.layers[0].addedX, 0);
  assert.equal(sol.achievedMetric, 1);
});

test('反解响应携带代回正向核算的完整结果，且与限值判定一致', () => {
  const buildup = { mode: 'linear', coefficient: 0.3 };
  const sol = solveInverseThickness(
    [
      { material: 'Pb', mu: 2, x: 0.3, adjustable: true, maxX: Infinity },
      { material: 'conc', mu: 0.5, x: 2, adjustable: false },
    ],
    { metric: 'broadTransmission', limit: 0.02, buildup, fluenceRate: 3000 },
  );
  assert.equal(sol.feasible, true);
  assert.equal(sol.target.metric, 'broadTransmission');
  assert.equal(sol.target.limit, 0.02);
  // forward 字段就是 evaluateShielding 对反解厚度的完整核算。
  assert.equal(sol.forward.layers.length, 2);
  assert.ok(sol.forward.broadTransmission <= 0.02 + 1e-12);
  assert.equal(sol.forward.transmittedFluenceRate, 3000 * sol.forward.broadTransmission);
  assert.equal(sol.achievedMetric, sol.forward.broadTransmission);
  // 固定层厚度原样保留。
  assert.equal(sol.layers[1].x, 2);
  assert.equal(sol.layers[1].addedX, 0);
  assert.equal(sol.layers[1].adjustable, false);
});

test('扫描：随机层数/μ/初厚/限值下 round-trip 与最小性都成立', () => {
  for (let i = 0; i < 200; i++) {
    const n = 1 + Math.floor(Math.random() * 3);
    const mode = Math.random() < 0.5 ? 'direct' : 'linear';
    const buildup = mode === 'direct'
      ? { mode: 'direct', value: 1 + Math.random() * 3 }
      : { mode: 'linear', coefficient: Math.random() * 4 }; // 含 k>1 非单调
    const layers = Array.from({ length: n }, (_, j) => {
      const adjustable = j === n - 1 || Math.random() < 0.5;
      return {
        material: `m${j}`,
        mu: 0.1 + Math.random() * 3,
        x: Math.random() * 0.5,
        adjustable,
        maxX: Infinity,
      };
    });
    if (!layers.some((l) => l.adjustable)) layers[0].adjustable = true;
    const limit = 1e-1 ** (1 + Math.random() * 4); // 1e-5 .. 0.1

    let sol;
    try {
      sol = solveInverseThickness(layers, { metric: 'broadTransmission', limit, buildup });
    } catch (err) {
      // 不封顶的可调层存在时渐近透射率为 0，永远不该报不可达。
      throw new Error(`不封顶场景不应失败：${err.code} ${err.message}`);
    }
    const back = reevaluate(sol, buildup);
    assert.ok(back.broadTransmission <= limit * (1 + 1e-10),
      `round-trip 越限: ${back.broadTransmission} > ${limit}`);
    if (sol.baselineFeasible) {
      // 基线已达标：零增量，谈不上再削薄。
      assert.equal(sol.addedOpticalDepth, 0);
    } else {
      assertMinimal(sol, buildup, { metric: 'broadTransmission', limit }, 1e-7);
    }
    // 固定层厚度必须原样不动。
    for (let j = 0; j < n; j++) {
      if (!layers[j].adjustable) assert.equal(sol.layers[j].x, layers[j].x);
    }
  }
});
