/**
 * 反求厚度（按目标限值反解最小厚度）测试。
 *
 * 钉死的几件事：
 *  1. round-trip 自洽：反解厚度交给正向核算 evaluateShielding 重算，
 *     目标指标必须严格 <= 给定上限；
 *  2. 最小性：把反解厚度削掉一丁点（~1e-9 光学厚度），指标必须越过限值；
 *  3. direct 与 linear 两种积累因子模式都成立，尤其 linear k>1 时
 *     透射率先增后减（驼峰 T>1），不能解到上升支的假根；
 *  4. 多层部分层固定：固定层分毫不动，附加光学厚度只落在可调层；
 *  5. 严苛目标在可调范围内不可达时，明确抛 TARGET_UNREACHABLE，
 *     不返回越限厚度、不返回 Infinity；
 *  6. 非法目标限值（透射率 <=0/>1、剂量率为负等）一律 400 拒绝。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reverseSolve } from '../src/physics/reverse.js';
import { evaluateShielding } from '../src/physics/multilayer.js';
import { TargetUnreachableError, ValidationError } from '../src/physics/errors.js';
import {
  validateReverseBody,
  validateSchemeReverseBody,
} from '../src/physics/validation.js';

/**
 * 独立 round-trip：只取反解给出的 mu/x，重新跑一遍正向核算，
 * 不引用反解响应里自带的 forward，避免「自己证明自己」。
 */
function independentForward(result, { fluenceRate = 1, buildup } = {}) {
  return evaluateShielding(
    result.layers.map((l) => ({ material: l.material, mu: l.mu, x: l.x })),
    { fluenceRate, buildup },
  );
}

/** 削薄：在第一个可调层上减掉 deltaOpticalDepth 的光学厚度。 */
function shave(result, deltaOpticalDepth = 1e-9) {
  const idx = result.adjustableLayers[0];
  const shaved = result.layers.map((l) => ({ material: l.material, mu: l.mu, x: l.x }));
  shaved[idx] = { ...shaved[idx], x: shaved[idx].x - deltaOpticalDepth / shaved[idx].mu };
  return shaved;
}

function metricValue(result, metric) {
  return metric === 'relativeDoseRate'
    ? result.forward.relativeDoseRate
    : result.forward.broadTransmission;
}

test('direct B=1：反解厚度落在 ln(1/limit)/μ，且正向重算严格不越限', () => {
  for (const [mu, limit] of [[1, 0.1], [0.577, 0.5], [2.5, 0.01], [Math.PI, 0.001]]) {
    const result = reverseSolve(
      [{ material: 'Pb', mu, x: 0, adjustable: true }],
      { target: { metric: 'broadTransmission', limit }, buildup: { mode: 'direct', value: 1 } },
    );
    assert.ok(Math.abs(result.layers[0].x - (-Math.log(limit) / mu)) < 1e-9,
      `μ=${mu},limit=${limit} 厚度偏离解析值`);
    // 反解自带的正向结果与独立重算一致，且严格 <= 限值。
    const fwd = independentForward(result, { buildup: { mode: 'direct', value: 1 } });
    assert.ok(fwd.broadTransmission <= limit, `重算 T=${fwd.broadTransmission} > ${limit}`);
    assert.equal(result.targetMet, true);
    assert.equal(result.forward.broadTransmission, fwd.broadTransmission);
  }
});

test('最小性：削掉 ~1e-9 光学厚度后透射率立即越过限值（B=1）', () => {
  const result = reverseSolve(
    [{ mu: 1.23, x: 0, adjustable: true }],
    { target: { metric: 'broadTransmission', limit: 0.07 }, buildup: { mode: 'direct', value: 1 } },
  );
  assert.ok(result.forward.broadTransmission <= 0.07);
  const fwd = evaluateShielding(shave(result), { buildup: { mode: 'direct', value: 1 } });
  assert.ok(fwd.broadTransmission > 0.07, `削薄后仍未越限：T=${fwd.broadTransmission}`);
});

test('direct B>1：反解同样成立；起步厚度本身非物理（薄处 B·T>1）也能跨到下降支', () => {
  // x=0.001、B=2 时正向核算本身会 422；反解不许被困在非物理段。
  const result = reverseSolve(
    [{ material: 'Pb', mu: 1, x: 0.001, adjustable: true }],
    { target: { metric: 'broadTransmission', limit: 0.1 }, buildup: { mode: 'direct', value: 2 } },
  );
  assert.ok(Math.abs(result.layers[0].x - Math.log(2 / 0.1)) < 1e-9);
  const fwd = independentForward(result, { buildup: { mode: 'direct', value: 2 } });
  assert.ok(fwd.broadTransmission <= 0.1);
  assert.equal(fwd.buildupFactor, 2);

  const shaved = evaluateShielding(shave(result), { buildup: { mode: 'direct', value: 2 } });
  assert.ok(shaved.broadTransmission > 0.1);
});

test('linear k<=1（单调）：反解厚度代回满足 (1+ky)e^-y <= limit，且削薄即越限', () => {
  for (const k of [0, 0.3, 1]) {
    const result = reverseSolve(
      [{ mu: 1, x: 0, adjustable: true }],
      { target: { metric: 'broadTransmission', limit: 0.1 }, buildup: { mode: 'linear', coefficient: k } },
    );
    const y = result.totalOpticalDepth;
    const fwd = independentForward(result, { buildup: { mode: 'linear', coefficient: k } });
    assert.ok(Math.abs(fwd.broadTransmission - (1 + k * y) * Math.exp(-y)) <= Number.EPSILON);
    assert.ok(fwd.broadTransmission <= 0.1, `k=${k} 重算越限`);
    const shaved = evaluateShielding(shave(result), { buildup: { mode: 'linear', coefficient: k } });
    assert.ok(shaved.broadTransmission > 0.1, `k=${k} 削薄后未越限，不是最小厚度`);
  }
});

test('linear k>1（非单调驼峰）：解必须在下降支，朴素取小根会错', () => {
  const k = 3;
  const limit = 0.1;
  // 前提：T(y)=(1+3y)e^-y 的峰值在 y=(k-1)/k=2/3，峰值 >1（正向会拒绝该段）。
  const peakY = (k - 1) / k;
  assert.ok((1 + k * peakY) * Math.exp(-peakY) > 1);

  const result = reverseSolve(
    [{ mu: 1, x: 0, adjustable: true }],
    { target: { metric: 'broadTransmission', limit }, buildup: { mode: 'linear', coefficient: k } },
  );
  const y = result.totalOpticalDepth;
  // 关键断言：落在驼峰之后的下降支，而不是上升支上的假根。
  assert.ok(y > peakY, `解 y=${y} 落在驼峰上/上升支`);
  const fwd = independentForward(result, { buildup: { mode: 'linear', coefficient: k } });
  assert.ok(fwd.broadTransmission <= limit);
  // 削薄仍在下降支附近：指标必须上升越限。
  const shaved = evaluateShielding(shave(result), { buildup: { mode: 'linear', coefficient: k } });
  assert.ok(shaved.broadTransmission > limit, `削薄后 T=${shaved.broadTransmission} 未越限`);
});

test('目标为相对剂量率：数值口径与宽束透射率一致，出射注量率=入射×指标', () => {
  const result = reverseSolve(
    [{ mu: 0.5, x: 0, adjustable: true }],
    {
      target: { metric: 'relativeDoseRate', limit: 0.25 },
      fluenceRate: 800,
      buildup: { mode: 'direct', value: 1 },
    },
  );
  assert.ok(result.forward.relativeDoseRate <= 0.25);
  assert.equal(result.forward.relativeDoseRate, result.forward.broadTransmission);
  assert.ok(Math.abs(result.forward.transmittedFluenceRate - 200) < 1e-12);
  const fwd = independentForward(result, { fluenceRate: 800, buildup: { mode: 'direct', value: 1 } });
  assert.ok(fwd.relativeDoseRate <= 0.25);
});

test('现状已达标：附加厚度为零，不画蛇添足砌厚墙', () => {
  // x=3、B=1 时 T=e^-3≈0.0498，限值 0.5 已满足。
  const result = reverseSolve(
    [{ mu: 1, x: 3, adjustable: true }],
    { target: { metric: 'broadTransmission', limit: 0.5 } },
  );
  assert.equal(result.addedOpticalDepth, 0);
  assert.equal(result.addedThickness, 0);
  assert.equal(result.layers[0].x, 3);
  assert.equal(result.targetMet, true);
});

test('限值等于 1：最小厚度就是零厚度', () => {
  const result = reverseSolve(
    [{ mu: 1, x: 0, adjustable: true }],
    { target: { metric: 'broadTransmission', limit: 1 }, buildup: { mode: 'direct', value: 5 } },
  );
  assert.equal(result.addedOpticalDepth, 0);
  assert.equal(result.forward.broadTransmission, 1);
});

test('多层部分固定：固定层贡献先扣掉，增量只加在可调层（两层等权）', () => {
  // 固定 Pb: μ=2,x=0.5 → 光学厚度 1；两块可调层从 x=0 起。
  // B=1、limit=0.01 → 需要总光学厚度 ln100 ≈ 4.6052，附加 ≈ 3.6052。
  const layers = [
    { material: 'Pb', mu: 2, x: 0.5, adjustable: false },
    { material: 'conc', mu: 0.5, x: 0, adjustable: true },
    { material: 'fe', mu: 1, x: 0, adjustable: true },
  ];
  const result = reverseSolve(layers, {
    target: { metric: 'broadTransmission', limit: 0.01 },
    buildup: { mode: 'direct', value: 1 },
  });

  // 固定层分毫不动。
  assert.equal(result.layers[0].x, 0.5);
  assert.equal(result.layers[0].addedThickness, 0);
  assert.equal(result.layers[0].adjustable, false);
  // 附加光学厚度只在两个可调层上，等权 → 各得一半。
  const addedOd1 = result.layers[1].mu * result.layers[1].x;
  const addedOd2 = result.layers[2].mu * result.layers[2].x;
  assert.ok(Math.abs(addedOd1 - addedOd2) < 1e-9);
  assert.ok(Math.abs(result.totalOpticalDepth - Math.LN10 * 2) < 1e-9);
  assert.ok(Math.abs(result.addedOpticalDepth - (Math.LN10 * 2 - 1)) < 1e-9);

  const fwd = independentForward(result, { buildup: { mode: 'direct', value: 1 } });
  assert.ok(fwd.broadTransmission <= 0.01);
  // 最小性：任一可调层削薄都越限。
  const shavedLayers = result.layers.map((l) => ({ material: l.material, mu: l.mu, x: l.x }));
  shavedLayers[1] = { ...shavedLayers[1], x: shavedLayers[1].x - 1e-9 / shavedLayers[1].mu };
  assert.ok(evaluateShielding(shavedLayers, { buildup: { mode: 'direct', value: 1 } }).broadTransmission > 0.01);
});

test('多层增量按 weight 比例分配；固定层即使很厚也不动', () => {
  const layers = [
    { material: 'fixed', mu: 4, x: 1, adjustable: false }, // 已贡献 od=4
    { material: 'a', mu: 2, x: 0, adjustable: true, weight: 3 },
    { material: 'b', mu: 1, x: 0, adjustable: true, weight: 1 },
  ];
  const result = reverseSolve(layers, {
    target: { metric: 'broadTransmission', limit: 0.02 },
    buildup: { mode: 'linear', coefficient: 0.4 },
  });
  const odA = result.layers[1].mu * result.layers[1].x;
  const odB = result.layers[2].mu * result.layers[2].x;
  assert.ok(Math.abs(odA / odB - 3) < 1e-9, '附加光学厚度应按 3:1 分配');
  assert.equal(result.layers[0].x, 1);
  const fwd = independentForward(result, { buildup: { mode: 'linear', coefficient: 0.4 } });
  assert.ok(fwd.broadTransmission <= 0.02);
  // 线性模式取最外层（b）。
  assert.equal(fwd.buildupBasis.outerLayer, 'b');
});

test('可调层起始厚度非零：增量从当前厚度往上加，不从零重算', () => {
  // μ=1、x=1 已贡献 od=1；limit=0.1 需总 od=ln10，附加 = ln10-1。
  const result = reverseSolve(
    [{ material: 'Pb', mu: 1, x: 1, adjustable: true }],
    { target: { metric: 'broadTransmission', limit: 0.1 }, buildup: { mode: 'direct', value: 1 } },
  );
  assert.ok(Math.abs(result.layers[0].x - Math.LN10) < 1e-9);
  assert.ok(Math.abs(result.addedOpticalDepth - (Math.LN10 - 1)) < 1e-9);
  assert.ok(Math.abs(result.layers[0].addedThickness - (Math.LN10 - 1)) < 1e-9);
});

test('不可达：可调层顶到 maxX 仍压不到目标 → TARGET_UNREACHABLE，且不返回 Infinity/越限厚度', () => {
  // 唯一可调层最多加到 x=1（od=1），最好成绩 e^-1≈0.368，压不到 0.01。
  let caught;
  try {
    reverseSolve(
      [{ mu: 1, x: 0, adjustable: true, maxX: 1 }],
      { target: { metric: 'broadTransmission', limit: 0.01 }, buildup: { mode: 'direct', value: 1 } },
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof TargetUnreachableError);
  assert.equal(caught.statusCode, 422);
  assert.equal(caught.code, 'TARGET_UNREACHABLE');
  // 报告里给出顶格时实际能达到的有限最优值与顶格厚度，供调用方核对。
  assert.ok(Number.isFinite(caught.details.bestAchievable));
  assert.ok(caught.details.bestAchievable > 0.01);
  assert.ok(Math.abs(caught.details.bestAchievable - Math.exp(-1)) < 1e-12);
  for (const l of caught.details.maxedLayers) {
    assert.ok(Number.isFinite(l.x));
    assert.equal(l.x, 1);
  }
});

test('不可达（线性 k>1）：顶格仍在驼峰非物理段，bestAchievable=null 而不是吐 Infinity', () => {
  let caught;
  try {
    // k=3 的驼峰峰值在 y=2/3；把唯一可调层封死在 x=0.2（od=0.2），
    // 整段 T>1 属于正向核算拒绝的非物理区。
    reverseSolve(
      [{ mu: 1, x: 0, adjustable: true, maxX: 0.2 }],
      { target: { metric: 'broadTransmission', limit: 0.1 }, buildup: { mode: 'linear', coefficient: 3 } },
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof TargetUnreachableError);
  assert.equal(caught.details.bestAchievable, null);
  assert.ok(Number.isFinite(caught.details.maxAddedOpticalDepth));
});

test('多个可调层都顶格才判不可达：固定层+可调层的贡献一起入账', () => {
  let caught;
  try {
    reverseSolve(
      [
        { material: 'fixed', mu: 1, x: 0.1, adjustable: false },
        { material: 'a', mu: 1, x: 0, adjustable: true, maxX: 0.1 },
      ],
      { target: { metric: 'broadTransmission', limit: 1e-6 }, buildup: { mode: 'direct', value: 1 } },
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof TargetUnreachableError);
  // 顶格总 od = 0.2 → 最好成绩 e^-0.2。
  assert.ok(Math.abs(caught.details.bestAchievable - Math.exp(-0.2)) < 1e-12);
  assert.ok(caught.details.bestAchievable > 1e-6);
});

test('反解响应自带完整正向核算结果，且与独立重算逐字段一致', () => {
  const result = reverseSolve(
    [{ material: 'Pb', mu: 0.577, x: 0.3, adjustable: true }],
    {
      target: { metric: 'broadTransmission', limit: 0.05 },
      fluenceRate: 2000,
      buildup: { mode: 'linear', coefficient: 0.25 },
    },
  );
  const fwd = independentForward(result, { fluenceRate: 2000, buildup: { mode: 'linear', coefficient: 0.25 } });
  for (const key of [
    'narrowTransmission', 'broadTransmission', 'totalTransmission',
    'relativeDoseRate', 'totalOpticalDepth', 'effectiveMu',
    'transmittedFluenceRate', 'buildupFactor',
  ]) {
    assert.equal(result.forward[key], fwd[key], `正向字段 ${key} 与独立重算不一致`);
  }
  assert.equal(result.achieved.broadTransmission, result.forward.broadTransmission);
  assert.equal(result.achieved.transmittedFluenceRate, result.forward.transmittedFluenceRate);
});

test('反解不改调用方传入的层对象（具名方案复用安全）', () => {
  const layers = [{ material: 'Pb', mu: 1, x: 1, adjustable: true }];
  const snapshot = JSON.parse(JSON.stringify(layers));
  reverseSolve(layers, { target: { metric: 'broadTransmission', limit: 0.1 } });
  assert.deepEqual(layers, snapshot);
  assert.equal(layers[0].maxX, undefined);
});

// ---------- 反解特有校验 ----------

function expectValidation(fn, fieldIncludes) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ValidationError);
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, 'VALIDATION_ERROR');
    const fields = err.details.map((d) => d.field);
    for (const f of fieldIncludes) assert.ok(fields.includes(f), `应报告 ${f}，实际：${fields}`);
    return true;
  });
}

test('透射率上限必须落在 (0,1]：0、负数、>1、非数值全部拒绝', () => {
  for (const limit of [0, -0.1, 1.0001, NaN, '0.1', Infinity]) {
    expectValidation(
      () => validateReverseBody({ layers: [{ mu: 1, x: 0, adjustable: true }], target: { metric: 'broadTransmission', limit } }),
      ['target.limit'],
    );
  }
  // 恰好 1 合法（零厚度即可）。
  assert.doesNotThrow(() =>
    validateReverseBody({ layers: [{ mu: 1, x: 0, adjustable: true }], target: { metric: 'broadTransmission', limit: 1 } }));
});

test('相对剂量率上限不能为负；metric 非法拒绝', () => {
  expectValidation(
    () => validateReverseBody({ layers: [{ mu: 1, x: 0, adjustable: true }], target: { metric: 'relativeDoseRate', limit: -1 } }),
    ['target.limit'],
  );
  expectValidation(
    () => validateReverseBody({ layers: [{ mu: 1, x: 0, adjustable: true }], target: { metric: 'narrowTransmission', limit: 0.1 } }),
    ['target.metric'],
  );
  expectValidation(
    () => validateReverseBody({ layers: [{ mu: 1, x: 0, adjustable: true }] }),
    ['target'],
  );
});

test('没有可调层却声称反求 → 400（包括所有层都缺省 adjustable）', () => {
  expectValidation(
    () => validateReverseBody({ layers: [{ mu: 1, x: 1 }, { mu: 2, x: 0.5 }], target: { metric: 'broadTransmission', limit: 0.1 } }),
    ['layers'],
  );
});

test('反解层字段：maxX 不能小于 x，weight 必须为正，adjustable 必须是布尔', () => {
  expectValidation(
    () => validateReverseBody({ layers: [{ mu: 1, x: 2, adjustable: true, maxX: 1 }], target: { metric: 'broadTransmission', limit: 0.1 } }),
    ['layers[0].maxX'],
  );
  expectValidation(
    () => validateReverseBody({ layers: [{ mu: 1, x: 0, adjustable: true, weight: 0 }], target: { metric: 'broadTransmission', limit: 0.1 } }),
    ['layers[0].weight'],
  );
  expectValidation(
    () => validateReverseBody({ layers: [{ mu: 1, x: 0, adjustable: 'yes' }], target: { metric: 'broadTransmission', limit: 0.1 } }),
    ['layers[0].adjustable'],
  );
  // 反解仍沿用既有口径：μ<=0、x<0 继续被拒。
  expectValidation(
    () => validateReverseBody({ layers: [{ mu: 0, x: -1, adjustable: true }], target: { metric: 'broadTransmission', limit: 0.1 } }),
    ['layers[0].mu', 'layers[0].x'],
  );
});

test('一次性反解支持单层平铺与 layer 包裹', () => {
  const flat = validateReverseBody({ mu: 1, x: 0, adjustable: true, target: { metric: 'broadTransmission', limit: 0.1 } });
  assert.equal(flat.layers[0].adjustable, true);
  const wrapped = validateReverseBody({ layer: { mu: 1, x: 0, adjustable: true, maxX: 5 }, target: { metric: 'broadTransmission', limit: 0.1 } });
  assert.equal(wrapped.layers[0].maxX, 5);
});

test('方案反解：按下标/材料名/对象标记可调层，并可覆盖 maxX、weight', () => {
  const scheme = [
    { material: 'Pb', mu: 2, x: 1 },
    { material: 'conc', mu: 0.5, x: 4 },
  ];
  const byIndex = validateSchemeReverseBody(
    { target: { metric: 'broadTransmission', limit: 0.1 }, adjustable: [0] },
    scheme,
  );
  assert.deepEqual(byIndex.layers.map((l) => l.adjustable), [true, false]);

  const byName = validateSchemeReverseBody(
    { target: { metric: 'broadTransmission', limit: 0.1 }, adjustable: ['conc'] },
    scheme,
  );
  assert.deepEqual(byName.layers.map((l) => l.adjustable), [false, true]);

  const byObject = validateSchemeReverseBody(
    { target: { metric: 'broadTransmission', limit: 0.1 }, adjustable: [{ index: 1, maxX: 6, weight: 2 }] },
    scheme,
  );
  assert.equal(byObject.layers[1].adjustable, true);
  assert.equal(byObject.layers[1].maxX, 6);
  assert.equal(byObject.layers[1].weight, 2);
  // 不污染原方案对象。
  assert.equal(scheme[1].adjustable, undefined);
});

test('方案反解：未标可调层、下标越界、材料名不存在都被拒绝', () => {
  const scheme = [{ material: 'Pb', mu: 2, x: 1 }];
  expectValidation(
    () => validateSchemeReverseBody({ target: { metric: 'broadTransmission', limit: 0.1 } }, scheme),
    ['layers'],
  );
  expectValidation(
    () => validateSchemeReverseBody({ target: { metric: 'broadTransmission', limit: 0.1 }, adjustable: [3] }, scheme),
    ['adjustable[0]'],
  );
  expectValidation(
    () => validateSchemeReverseBody({ target: { metric: 'broadTransmission', limit: 0.1 }, adjustable: ['Fe'] }, scheme),
    ['adjustable[0]'],
  );
  expectValidation(
    () => validateSchemeReverseBody({ target: { metric: 'broadTransmission', limit: 0.1 }, adjustable: [{ index: 0, maxX: 0.1 }] }, scheme),
    ['adjustable[0].maxX'],
  );
});
