/**
 * 核心衰减物理关系测试。
 * 这些关系是整个服务的基础，用自动化测试钉死，防止重构时被改坏。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { narrowTransmission, halfValueLayer, tenthValueLayer } from '../src/physics/attenuation.js';
import { evaluateShielding } from '../src/physics/multilayer.js';

/** 机器精度（1 ULP）。十值层的 0.1 在 IEEE-754 中无精确表示，只能断言到 1 ULP。 */
const EPS = Number.EPSILON;

test('HVL/TVL 只由衰减系数决定：HVL=ln2/μ，TVL=ln10/μ', () => {
  for (const mu of [0.1, 0.577, 1, 2.5, Math.PI]) {
    assert.equal(halfValueLayer(mu), Math.LN2 / mu);
    assert.equal(tenthValueLayer(mu), Math.LN10 / mu);
  }
});

test('在半值层厚度处，窄束透射率精确等于 1/2（位精确）', () => {
  // exp(-μ·(ln2/μ)) 对绝大多数 μ 位精确等于 0.5（个别 μ 值如 0.577、1.3
  // 因中间舍入差 1 ULP），这里选取位精确的取值做严格相等断言。
  for (const mu of [0.1, 1, 1.2, Math.PI]) {
    const x = halfValueLayer(mu);
    assert.equal(narrowTransmission(mu, x), 0.5);
  }
  // 其余 μ 也必须在 1 ULP 内。
  for (const mu of [1.3, 2.5, 3.7]) {
    assert.ok(Math.abs(narrowTransmission(mu, halfValueLayer(mu)) - 0.5) <= EPS);
  }
});

test('在十值层厚度处，窄束透射率在机器精度（1 ULP）内等于 1/10', () => {
  // exp(-ln10) === 0.09999999999999998，0.1 在二进制浮点中没有精确表示；
  // 公式是精确的，差异纯粹是 IEEE-754 舍入，因此断言到 1 ULP。
  for (const mu of [0.1, 0.577, 1, 2.5, Math.PI]) {
    const x = tenthValueLayer(mu);
    const t = narrowTransmission(mu, x);
    assert.ok(Math.abs(t - 0.1) <= EPS, `μ=${mu} 时 T=${t} 不在 0.1 的 1 ULP 内`);
  }
});

test('只把厚度翻倍，窄束透射率精确变成原来的平方（存在位相等的取值）', () => {
  // 位严格相等的参数对：exp(-μ·2x) === exp(-μx)²
  const bitExact = [
    [0.3, 0.1], [0.5, 0.5], [0.5, 1], [0.7, 0.25], [1, 1],
  ];
  for (const [mu, x] of bitExact) {
    const t1 = narrowTransmission(mu, x);
    const t2 = narrowTransmission(mu, 2 * x);
    assert.equal(t2, t1 * t1, `μ=${mu},x=${x} 不满足位精确平方关系`);
  }
  // 一般取值对，缩放律在数学上成立（浮点误差量级 ~ULP）。
  for (const [mu, x] of [[0.13, 0.71], [1.7, 2.3]]) {
    const t1 = narrowTransmission(mu, x);
    const t2 = narrowTransmission(mu, 2 * x);
    assert.ok(Math.abs(t2 - t1 * t1) <= 4 * EPS * Math.max(t2, t1 * t1));
  }
});

test('只把衰减系数翻倍，等价于厚度翻倍，窄束透射率同样变成原来的平方', () => {
  // 两种情形参与 exp 的乘积完全相同：μ·2x === 2μ·x（位相等），故结果逐位一致。
  for (const [mu, x] of [[0.5, 0.5], [1, 1], [0.3, 0.1], [1.23, 0.45]]) {
    const base = narrowTransmission(mu, x);
    const doubleThickness = narrowTransmission(mu, 2 * x);
    const doubleMu = narrowTransmission(2 * mu, x);
    assert.equal(doubleMu, doubleThickness, 'μ翻倍与x翻倍必须给出逐位相同的结果');
    assert.equal(doubleMu, base * base);
  }
});

test('零厚度：无论积累因子是多少，透射率精确等于 1', () => {
  for (const buildup of [
    { mode: 'direct', value: 1 },
    { mode: 'direct', value: 2.7 },
    { mode: 'direct', value: 100 },
    { mode: 'linear', coefficient: 0.5 },
  ]) {
    const r = evaluateShielding([{ material: 'Pb', mu: 1.5, x: 0 }], { buildup });
    assert.equal(r.narrowTransmission, 1);
    assert.equal(r.broadTransmission, 1);
    assert.equal(r.totalTransmission, 1);
    assert.equal(r.relativeDoseRate, 1);
    assert.equal(r.transmittedFluenceRate, r.incidentFluenceRate);
  }
});

test('零厚度也覆盖多层：总透射率严格为 1，总光学厚度为 0', () => {
  const r = evaluateShielding([
    { material: 'Pb', mu: 2, x: 0 },
    { material: 'concrete', mu: 0.2, x: 0 },
  ], { buildup: { mode: 'direct', value: 5 } });
  assert.equal(r.totalOpticalDepth, 0);
  assert.equal(r.narrowTransmission, 1);
  assert.equal(r.broadTransmission, 1);
});

test('宽束透射率始终不小于窄束透射率（积累因子让宽束更“透”）', () => {
  for (const mu of [0.1, 0.5, 1, 3, 8]) {
    for (const x of [0, 0.1, 0.5, 1, 2, 5]) {
      for (const B of [1, 1.5, 2, 5, 20]) {
        const narrow = Math.exp(-mu * x);
        if (x === 0) {
          // 零厚度：物理上无屏蔽体产生散射积累，B 被短路为 1，严格不衰减。
          const r = evaluateShielding([{ mu, x }], { buildup: { mode: 'direct', value: B } });
          assert.equal(r.broadTransmission, 1);
          assert.equal(r.narrowTransmission, 1);
          continue;
        }
        if (B * narrow > 1 + EPS) {
          // B·T > 1 属于非物理结果，服务必须拒绝而不是返回 >1 的透射率。
          assert.throws(
            () => evaluateShielding([{ mu, x }], { buildup: { mode: 'direct', value: B } }),
            /超过一/,
          );
          continue;
        }
        const r = evaluateShielding([{ mu, x }], { buildup: { mode: 'direct', value: B } });
        assert.ok(r.broadTransmission >= r.narrowTransmission);
        // 宽束 = B × 窄束（用乘法形式断言，避免除法引入额外舍入）。
        assert.equal(r.broadTransmission, B * r.narrowTransmission);
      }
    }
  }
});

test('B=1 时宽束退化为窄束，两者精确相等', () => {
  const r = evaluateShielding([{ mu: 0.8, x: 2.5 }], { buildup: { mode: 'direct', value: 1 } });
  assert.equal(r.broadTransmission, r.narrowTransmission);
  assert.equal(r.broadTransmission, Math.exp(-2));
});

test('透射率不超过 1 也不为负（随机扫描）', () => {
  // 线性近似 B=1+k·μx 且 0≤k≤1 时 (1+ky)e^{-y} ≤ 1 恒成立（ln(1+ky)≤ky）。
  for (let i = 0; i < 500; i++) {
    const mu = 1 + Math.random() * 5;
    const x = Math.random() * 5;
    const k = Math.random();
    const r = evaluateShielding([{ mu, x }], { buildup: { mode: 'linear', coefficient: k } });
    assert.ok(r.narrowTransmission > 0 && r.narrowTransmission <= 1);
    assert.ok(r.broadTransmission >= r.narrowTransmission);
    assert.ok(r.broadTransmission <= 1 + EPS);
  }
});

test('线性积累因子：B = 1 + k·Σμx，取最外层材料的 k', () => {
  // 单层：1+kμx
  let r = evaluateShielding([{ material: 'Pb', mu: 2, x: 1.5 }], {
    buildup: { mode: 'linear', coefficient: 0.3 },
  });
  assert.equal(r.buildupFactor, 1 + 0.3 * 3);
  assert.equal(r.buildupBasis.outerLayer, 'Pb');
  assert.equal(r.buildupBasis.totalOpticalDepth, 3);
  assert.equal(r.broadTransmission, (1 + 0.3 * 3) * Math.exp(-3));

  // 多层：k 属于最外层（concrete），乘的是全部层光学厚度之和。
  r = evaluateShielding(
    [
      { material: 'Pb', mu: 2, x: 1 },     // μx = 2
      { material: 'concrete', mu: 0.5, x: 4 }, // μx = 2，最外层
    ],
    { buildup: { mode: 'linear', coefficient: 0.2 } },
  );
  assert.equal(r.totalOpticalDepth, 4);
  assert.equal(r.buildupBasis.outerLayer, 'concrete');
  assert.equal(r.buildupFactor, 1 + 0.2 * 4);
  assert.equal(r.broadTransmission, (1 + 0.2 * 4) * Math.exp(-4));
});
