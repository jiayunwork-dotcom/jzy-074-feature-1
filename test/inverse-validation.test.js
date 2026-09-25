/**
 * 反解接口参数校验测试，沿用现有校验口径，外加反解特有的约束：
 *  - 目标限值必须在物理可达区间（透射率 0<limit<=1，剂量率 limit>0）；
 *  - 可调层集合不能为空；
 *  - maxX 必须非负且不小于该层当前厚度，且只能给可调层；
 *  - 具名方案引用的层序号必须合法、不重复。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateInverseBody,
  validateSchemeInverseBody,
  resolveAdjustableLayers,
} from '../src/physics/validation.js';
import { ValidationError } from '../src/physics/errors.js';

function expectValidation(fn, fieldIncludes) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ValidationError);
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, 'VALIDATION_ERROR');
    const fields = err.details.map((d) => d.field);
    for (const f of fieldIncludes) assert.ok(fields.includes(f), `应报告字段 ${f}，实际：${fields}`);
    return true;
  });
}

const goodLayer = { mu: 1, x: 0, adjustable: true };

test('目标限值：透射率上限必须在 (0,1]', () => {
  for (const limit of [0, -0.1, -1, 1.0001, 2, NaN, Infinity]) {
    expectValidation(
      () => validateInverseBody({ layers: [goodLayer], target: { metric: 'broadTransmission', limit } }),
      ['target.limit'],
    );
  }
  // 边界合法值不抛。
  assert.doesNotThrow(() =>
    validateInverseBody({ layers: [goodLayer], target: { metric: 'broadTransmission', limit: 1 } }));
  assert.doesNotThrow(() =>
    validateInverseBody({ layers: [goodLayer], target: { metric: 'broadTransmission', limit: 1e-9 } }));
});

test('目标限值：剂量率上限必须 >0（可以 >1，表示零厚度即达标）', () => {
  for (const limit of [0, -0.5, -10, NaN, Infinity]) {
    expectValidation(
      () => validateInverseBody({ layers: [goodLayer], target: { metric: 'relativeDoseRate', limit } }),
      ['target.limit'],
    );
  }
  assert.doesNotThrow(() =>
    validateInverseBody({ layers: [goodLayer], target: { metric: 'relativeDoseRate', limit: 5 } }));
});

test('目标指标缺失或非法：拒绝并指明 target.metric；缺省 metric 按宽束透射率', () => {
  expectValidation(
    () => validateInverseBody({ layers: [goodLayer], target: { metric: 'narrowTransmission', limit: 0.5 } }),
    ['target.metric'],
  );
  expectValidation(() => validateInverseBody({ layers: [goodLayer] }), ['target']);
  expectValidation(() => validateInverseBody({ layers: [goodLayer], target: null }), ['target']);
  const parsed = validateInverseBody({ layers: [goodLayer], target: { limit: 0.5 } });
  assert.equal(parsed.target.metric, 'broadTransmission');
});

test('可调层集合不能为空：所有层都未标 adjustable 时拒绝', () => {
  expectValidation(
    () => validateInverseBody({ layers: [{ mu: 1, x: 1 }, { mu: 2, x: 0 }], target: { limit: 0.5 } }),
    ['layers'],
  );
  expectValidation(
    () => validateInverseBody({ layer: { mu: 1, x: 1 }, target: { limit: 0.5 } }),
    ['layers'],
  );
  // 显式 false 与非布尔值：前者算无可调层，后者额外报类型错。
  expectValidation(
    () => validateInverseBody({ layers: [{ mu: 1, x: 1, adjustable: false }], target: { limit: 0.5 } }),
    ['layers'],
  );
  expectValidation(
    () => validateInverseBody({ layers: [{ mu: 1, x: 1, adjustable: 'yes' }], target: { limit: 0.5 } }),
    ['layers[0].adjustable'],
  );
});

test('反解沿用现有层校验：mu>0、x>=0，错误与正向接口同字段名', () => {
  expectValidation(
    () => validateInverseBody({ layers: [{ mu: -1, x: -2, adjustable: true }], target: { limit: 0.5 } }),
    ['layers[0].mu', 'layers[0].x'],
  );
});

test('maxX 只能给可调层，且必须是非负有限数、不小于当前 x', () => {
  expectValidation(
    () => validateInverseBody({
      layers: [{ mu: 1, x: 1, maxX: 2 }],
      target: { limit: 0.5 },
    }),
    ['layers[0].maxX'],
  );
  for (const maxX of [-0.01, NaN, Infinity, '5']) {
    expectValidation(
      () => validateInverseBody({
        layers: [{ mu: 1, x: 1, adjustable: true, maxX }],
        target: { limit: 0.5 },
      }),
      ['layers[0].maxX'],
    );
  }
  expectValidation(
    () => validateInverseBody({
      layers: [{ mu: 1, x: 3, adjustable: true, maxX: 2.9 }],
      target: { limit: 0.5 },
    }),
    ['layers[0].maxX'],
  );
  // 合法：maxX 缺省表示不封顶（Infinity），显式给出不小于 x 的值也合法。
  const a = validateInverseBody({ layers: [{ mu: 1, x: 0, adjustable: true }], target: { limit: 0.5 } });
  assert.equal(a.layers[0].maxX, Infinity);
  assert.doesNotThrow(() => validateInverseBody({
    layers: [{ mu: 1, x: 3, adjustable: true, maxX: 3 }],
    target: { limit: 0.5 },
  }));
});

test('layer 包裹写法可用；同时给 layer 与 layers 被拒绝', () => {
  const parsed = validateInverseBody({
    layer: { mu: 1, x: 0, adjustable: true, maxX: 5 },
    target: { limit: 0.1 },
  });
  assert.equal(parsed.layers.length, 1);
  expectValidation(
    () => validateInverseBody({
      layer: { mu: 1, x: 0, adjustable: true },
      layers: [{ mu: 2, x: 0, adjustable: true }],
      target: { limit: 0.1 },
    }),
    ['layers'],
  );
});

test('反解同样聚合 fluenceRate 与 buildup 的校验错误', () => {
  expectValidation(
    () => validateInverseBody({
      layers: [goodLayer],
      target: { limit: 0.5 },
      fluenceRate: -1,
      buildup: { mode: 'direct', value: 0.2 },
    }),
    ['fluenceRate', 'buildup.value'],
  );
});

test('具名方案反解：adjustable 必须是非空层序号数组', () => {
  expectValidation(() => validateSchemeInverseBody({ target: { limit: 0.5 } }), ['adjustable']);
  expectValidation(() => validateSchemeInverseBody({ target: { limit: 0.5 }, adjustable: [] }), ['adjustable']);
  expectValidation(() => validateSchemeInverseBody({ target: { limit: 0.5 }, adjustable: {} }), ['adjustable']);
  expectValidation(
    () => validateSchemeInverseBody({ target: { limit: 0.5 }, adjustable: [-1, 1.5, '0', null] }),
    ['adjustable[0]', 'adjustable[1]', 'adjustable[2]', 'adjustable[3]'],
  );
});

test('具名方案反解：层序号重复被拒绝', () => {
  expectValidation(
    () => validateSchemeInverseBody({ target: { limit: 0.5 }, adjustable: [0, 0] }),
    ['adjustable[1]'],
  );
});

test('resolveAdjustableLayers：序号越界、maxX 小于已登记厚度都被拒绝', () => {
  const schemeLayers = [{ material: 'Pb', mu: 2, x: 1 }, { material: 'conc', mu: 0.5, x: 4 }];
  expectValidation(() => resolveAdjustableLayers(schemeLayers, [{ index: 2 }]), ['adjustable']);
  expectValidation(() => resolveAdjustableLayers(schemeLayers, [{ index: 0, maxX: 0.5 }]), ['adjustable[0].maxX']);

  const resolved = resolveAdjustableLayers(schemeLayers, [{ index: 1, maxX: 6 }]);
  assert.equal(resolved[0].adjustable, false);
  assert.equal(resolved[0].maxX, undefined);
  assert.equal(resolved[1].adjustable, true);
  assert.equal(resolved[1].maxX, 6);

  // 纯数字序号经 validateSchemeInverseBody 归一化后等价于不封顶。
  const { adjustable } = validateSchemeInverseBody({
    target: { metric: 'broadTransmission', limit: 0.5 },
    adjustable: [0],
  });
  const resolved2 = resolveAdjustableLayers(schemeLayers, adjustable);
  assert.equal(resolved2[0].adjustable, true);
  assert.equal(resolved2[0].maxX, Infinity);
});
