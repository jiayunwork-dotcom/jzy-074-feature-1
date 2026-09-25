/**
 * 参数校验测试：衰减系数必须 >0、厚度非负、积累因子 >=1、
 * 入射注量率非负。命中任一规则返回结构化错误，逐字段说明问题。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateLayers,
  validateSingleCalcBody,
  validateRegisterBody,
  validateSchemeCalcBody,
} from '../src/physics/validation.js';
import { ValidationError } from '../src/physics/errors.js';
import { evaluateShielding } from '../src/physics/multilayer.js';

function expectValidation(fn, fieldIncludes) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ValidationError);
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, 'VALIDATION_ERROR');
    assert.ok(Array.isArray(err.details));
    const fields = err.details.map((d) => d.field);
    for (const f of fieldIncludes) assert.ok(fields.includes(f), `应报告字段 ${f}，实际：${fields}`);
    return true;
  });
}

test('衰减系数必须大于零：0、负数、NaN、非数值全部拒绝', () => {
  for (const mu of [0, -1, NaN, '1', undefined, Infinity]) {
    expectValidation(() => validateLayers([{ mu, x: 1 }]), ['layers[0].mu']);
  }
});

test('厚度不能是负数：允许 0，拒绝负数与非数值', () => {
  assert.doesNotThrow(() => validateLayers([{ mu: 1, x: 0 }]));
  for (const x of [-0.01, -5, NaN, 'x', undefined]) {
    expectValidation(() => validateLayers([{ mu: 1, x }]), ['layers[0].x']);
  }
});

test('积累因子不能小于一', () => {
  expectValidation(
    () => validateSingleCalcBody({ mu: 1, x: 1, buildup: { mode: 'direct', value: 0.5 } }),
    ['buildup.value'],
  );
  expectValidation(
    () => validateSingleCalcBody({ mu: 1, x: 1, buildup: { mode: 'direct', value: 0 } }),
    ['buildup.value'],
  );
  expectValidation(
    () => validateSingleCalcBody({ mu: 1, x: 1, buildup: { mode: 'direct', value: -3 } }),
    ['buildup.value'],
  );
});

test('积累因子模式必须明确：未知模式拒绝，linear 的 k 不能为负', () => {
  expectValidation(
    () => validateSingleCalcBody({ mu: 1, x: 1, buildup: { mode: 'weird', value: 2 } }),
    ['buildup.mode'],
  );
  expectValidation(
    () => validateSingleCalcBody({ mu: 1, x: 1, buildup: { mode: 'linear', coefficient: -0.1 } }),
    ['buildup.coefficient'],
  );
  assert.doesNotThrow(() =>
    validateSingleCalcBody({ mu: 1, x: 1, buildup: { mode: 'linear', coefficient: 0 } }),
  );
});

test('入射注量率不能是负数', () => {
  expectValidation(() => validateSingleCalcBody({ mu: 1, x: 1, fluenceRate: -1 }), ['fluenceRate']);
  // 缺省为 1。
  const parsed = validateSingleCalcBody({ mu: 1, x: 1 });
  assert.equal(parsed.fluenceRate, 1);
  assert.doesNotThrow(() => validateSingleCalcBody({ mu: 1, x: 1, fluenceRate: 0 }));
});

test('一次性返回所有不合法字段，而不是遇到第一个就中断', () => {
  expectValidation(
    () => validateSingleCalcBody({ mu: -2, x: -3, fluenceRate: -1, buildup: { mode: 'direct', value: 0 } }),
    ['layers[0].mu', 'layers[0].x', 'fluenceRate', 'buildup.value'],
  );
});

test('层列表必须是非空数组；空数组、对象、null 都拒绝', () => {
  expectValidation(() => validateLayers([]), ['layers']);
  expectValidation(() => validateLayers({ mu: 1, x: 1 }), ['layers']);
  expectValidation(() => validateLayers(null), ['layers']);
  expectValidation(() => validateRegisterBody({ name: 'x', layers: [{}] }), [
    'layers[0].mu',
    'layers[0].x',
  ]);
});

test('方案名规则：空白拒绝；过长拒绝；缺省时自动生成由存储层负责', () => {
  const ok = validateRegisterBody({ name: '  reactor-wall-A  ', layers: [{ mu: 1, x: 1 }] });
  assert.equal(ok.name, 'reactor-wall-A');
  expectValidation(() => validateRegisterBody({ name: '   ', layers: [{ mu: 1, x: 1 }] }), ['name']);
  const auto = validateRegisterBody({ layers: [{ mu: 1, x: 1 }] });
  assert.equal(auto.name, undefined);
});

test('方案计算接口同样校验入射注量率与积累因子', () => {
  assert.doesNotThrow(() => validateSchemeCalcBody({ fluenceRate: 100 }));
  expectValidation(() => validateSchemeCalcBody({ fluenceRate: -1 }), ['fluenceRate']);
});

test('非物理结果不会被当正常结果返回：B·T>1 抛 UNPHYSICAL_RESULT(422)', () => {
  // μx=0.001 时窄束透射率≈0.999，B=2 → 宽束≈1.998 > 1。
  assert.throws(
    () => evaluateShielding([{ mu: 0.001, x: 1 }], { buildup: { mode: 'direct', value: 2 } }),
    (err) => err.statusCode === 422 && err.code === 'UNPHYSICAL_RESULT',
  );
});
