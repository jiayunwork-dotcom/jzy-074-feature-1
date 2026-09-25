/**
 * 多层屏蔽叠加测试。
 * 重点：统一指数 exp(-Σμᵢxᵢ) 与逐层相乘 Π exp(-μᵢxᵢ) 在浮点上
 * 确实是两种不同的算法，服务必须采用前者，测试要能分辨差异。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateShielding, totalOpticalDepth } from '../src/physics/multilayer.js';

test('统一指数 vs 逐层相乘：存在可分辨的 ULP 级差异，服务采用统一指数', () => {
  // 这组取值在 IEEE-754 下两种算法结果不同（确定性，不依赖随机数）。
  const layers = [
    { material: 'Pb', mu: 0.5, x: 0.5 }, // μx = 0.25
    { material: 'conc', mu: 1, x: 2 },   // μx = 2
  ];
  const od = totalOpticalDepth(layers);
  const unified = Math.exp(-od);                        // 服务采用的算法
  const layerwise = Math.exp(-0.5 * 0.5) * Math.exp(-1 * 2); // 错误的算法
  assert.notEqual(unified, layerwise, '前提：这组取值必须真的能分辨两种算法');
  // 差异为 1 ULP（2^-56 ≈ 1.388e-17），即 IEEE-754 下最小的可分辨差异。
  assert.equal(Math.abs(unified - layerwise), 2 ** -56);

  const r = evaluateShielding(layers);
  assert.equal(r.totalOpticalDepth, od);
  assert.equal(r.narrowTransmission, unified);
  assert.notEqual(r.narrowTransmission, layerwise);
});

test('再给两组确定性差异取值，统一指数逐位吻合', () => {
  const cases = [
    [{ mu: 0.5, x: 0.5 }, { mu: 1.5, x: 1.5 }],
    [{ mu: 0.5, x: 0.5 }, { mu: 2, x: 1 }],
  ];
  for (const layers of cases) {
    const od = layers.reduce((s, l) => s + l.mu * l.x, 0);
    const r = evaluateShielding(layers);
    assert.equal(r.narrowTransmission, Math.exp(-od));
    assert.notEqual(
      r.narrowTransmission,
      layers.map((l) => Math.exp(-l.mu * l.x)).reduce((a, b) => a * b, 1),
    );
  }
});

test('数学上两种算法等价：差异只在 ULP 量级，不是公式错误', () => {
  const r = evaluateShielding([
    { material: 'Pb', mu: 0.5, x: 0.5 },
    { material: 'conc', mu: 1, x: 2 },
  ]);
  const layerwise = Math.exp(-0.25) * Math.exp(-2);
  assert.ok(Math.abs(r.narrowTransmission - layerwise) <= 4 * Number.EPSILON);
});

test('多层：各层 μx 逐层累加，层数增加只做加法，不重新推导公式', () => {
  const layers = [
    { material: 'Pb', mu: 2, x: 0.3 },
    { material: 'Fe', mu: 1, x: 1 },
    { material: 'conc', mu: 0.25, x: 4 },
  ];
  const r = evaluateShielding(layers);
  assert.equal(r.totalOpticalDepth, 0.6 + 1 + 1);
  assert.equal(r.narrowTransmission, Math.exp(-2.6));
  assert.equal(r.layerCount, 3);
  // 逐层 μx 与逐层 HVL/TVL 都在响应里给出。
  assert.deepEqual(r.layers.map((l) => l.opticalDepth), [0.6, 1, 1]);
  assert.equal(r.layers[0].hvl, Math.LN2 / 2);
  assert.equal(r.layers[2].tvl, Math.LN10 / 0.25);
});

test('多层：积累因子取最外层（最后一层）材料对应的值', () => {
  const layers = [
    { material: 'Pb', mu: 2, x: 1 },
    { material: 'concrete', mu: 0.5, x: 4 },
  ];
  const r = evaluateShielding(layers, { buildup: { mode: 'direct', value: 3 } });
  assert.equal(r.buildupBasis.outerLayer, 'concrete');
  assert.equal(r.buildupBasis.outerMu, 0.5);
  assert.equal(r.buildupFactor, 3);
  assert.equal(r.broadTransmission, 3 * Math.exp(-4));
});

test('多层：调换最外层材料，积累因子归属随之改变', () => {
  const a = evaluateShielding(
    [{ material: 'Pb', mu: 2, x: 1 }, { material: 'concrete', mu: 0.5, x: 4 }],
    { buildup: { mode: 'linear', coefficient: 0.4 } },
  );
  const b = evaluateShielding(
    [{ material: 'concrete', mu: 0.5, x: 4 }, { material: 'Pb', mu: 2, x: 1 }],
    { buildup: { mode: 'linear', coefficient: 0.4 } },
  );
  assert.equal(a.buildupBasis.outerLayer, 'concrete');
  assert.equal(b.buildupBasis.outerLayer, 'Pb');
  // 总光学厚度相同 → 窄束透射相同（顺序不影响衰减和）；k 是请求级参数时宽束也相同，
  // 但归属材料不同，说明服务确实按最外层取因子。
  assert.equal(a.totalOpticalDepth, b.totalOpticalDepth);
  assert.equal(a.narrowTransmission, b.narrowTransmission);
});

test('多层全零厚度：透射率精确为 1', () => {
  const r = evaluateShielding(
    [{ mu: 2, x: 0 }, { mu: 0.5, x: 0 }],
    { buildup: { mode: 'direct', value: 9 } },
  );
  assert.equal(r.totalOpticalDepth, 0);
  assert.equal(r.narrowTransmission, 1);
  assert.equal(r.broadTransmission, 1);
  assert.equal(r.hvl, null); // 总厚度为 0 时不存在有意义的等效 μ 与 HVL
});

test('等效衰减系数与整套结构的 HVL/TVL', () => {
  const layers = [
    { material: 'Pb', mu: 2, x: 1 },
    { material: 'conc', mu: 0.5, x: 3 },
  ];
  const r = evaluateShielding(layers);
  assert.equal(r.totalThickness, 4);
  assert.equal(r.effectiveMu, 3.5 / 4);
  assert.equal(r.hvl, Math.LN2 / r.effectiveMu);
  assert.equal(r.tvl, Math.LN10 / r.effectiveMu);
});

test('相对剂量率等于宽束透射率；出射注量率 = 入射 × 透射率', () => {
  const r = evaluateShielding([{ mu: 1, x: 1 }], {
    fluenceRate: 400,
    buildup: { mode: 'linear', coefficient: 0.5 },
  });
  assert.equal(r.relativeDoseRate, r.broadTransmission);
  assert.equal(r.transmittedFluenceRate, 400 * r.broadTransmission);
  assert.equal(r.incidentFluenceRate, 400);
});
