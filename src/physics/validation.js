/**
 * 参数校验。校验规则集中在此处，物理模块与路由模块共用，
 * 不允许各接口各自维护一套不一致的取值范围。
 *
 * 硬性规则：
 *  - 衰减系数 mu 必须 > 0
 *  - 厚度 x 必须 >= 0
 *  - 积累因子 B 必须 >= 1（直接指定模式）
 *  - 入射注量率 fluenceRate 必须 >= 0
 */
import { ValidationError } from './errors.js';

/** 防止传入 Infinity/天文数字导致结果无意义。 */
export const MAX_FINITE = 1e12;
export const MAX_NAME_LENGTH = 128;
export const MAX_LAYERS = 100;

/** 收集一个请求里所有不合法字段，一次性返回。 */
class FieldCollector {
  constructor() {
    this.errors = [];
  }

  /**
   * @param {string} field 字段路径，如 layers[1].mu
   * @param {string} message 具体问题
   */
  add(field, message) {
    this.errors.push({ field, message });
  }

  checkFiniteNumber(field, value, { positive = false, nonNegative = false } = {}) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      this.add(field, '必须是数值');
      return false;
    }
    if (!Number.isFinite(value) || Math.abs(value) > MAX_FINITE) {
      this.add(field, '必须是有限数值');
      return false;
    }
    if (positive && value <= 0) {
      this.add(field, '必须大于零');
      return false;
    }
    if (nonNegative && value < 0) {
      this.add(field, '不能是负数');
      return false;
    }
    return true;
  }

  throwIfAny() {
    if (this.errors.length > 0) throw new ValidationError(this.errors);
  }
}

/**
 * 校验一层屏蔽材料，问题记入 collector，不抛异常。
 * @param {any} layer
 * @param {number} index
 * @param {FieldCollector} c
 * @param {string} [fieldPrefix] 字段路径前缀（单层平铺接口下为 layers[0]）
 * @returns {{ material: string, mu: number, x: number } | null}
 */
function validateLayer(layer, index, c, fieldPrefix = `layers[${index}]`) {
  if (layer === null || typeof layer !== 'object' || Array.isArray(layer)) {
    c.add(fieldPrefix, '必须是包含 mu 与 x 的对象');
    return null;
  }
  const muOk = c.checkFiniteNumber(`${fieldPrefix}.mu`, layer.mu, { positive: true });
  const xOk = c.checkFiniteNumber(`${fieldPrefix}.x`, layer.x, { nonNegative: true });
  let material = layer.material;
  if (material !== undefined && material !== null) {
    if (typeof material !== 'string') {
      c.add(`${fieldPrefix}.material`, '必须是字符串');
      material = undefined;
    } else {
      material = material.trim();
    }
  }
  if (material === '' ) material = undefined;
  if (!(muOk && xOk)) return null;
  return { material: material ?? `layer-${index + 1}`, mu: layer.mu, x: layer.x };
}

/**
 * 校验并归一化层列表。
 * @param {any} raw
 * @param {{ minLayers?: number }} [options]
 * @returns {{ material: string, mu: number, x: number }[]}
 */
export function validateLayers(raw, { minLayers = 1 } = {}) {
  const c = new FieldCollector();
  const layers = collectLayers(raw, c, { minLayers });
  c.throwIfAny();
  return layers;
}

/** 仅收集层问题到给定 collector，供需要聚合其它字段错误的接口复用。 */
function collectLayers(raw, c, { minLayers = 1 } = {}) {
  if (!Array.isArray(raw)) {
    c.add('layers', '必须是非空数组，每层包含 mu 与 x');
    return [];
  }
  if (raw.length < minLayers) {
    c.add('layers', `至少需要 ${minLayers} 层`);
  }
  if (raw.length > MAX_LAYERS) {
    c.add('layers', `层数不能超过 ${MAX_LAYERS}`);
  }
  return raw.map((layer, i) => validateLayer(layer, i, c)).filter(Boolean);
}

/**
 * 校验单层核算接口的输入。所有字段问题聚合后一次性返回。
 * 支持两种写法：{ layer: {mu,x} } 或平铺 { mu, x }。
 */
export function validateSingleCalcBody(body) {
  const c = new FieldCollector();
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    c.add('body', '必须是 JSON 对象');
    c.throwIfAny();
  }

  let layers;
  if (body.layer !== undefined) {
    layers = collectLayers([body.layer], c, { minLayers: 1 });
  } else {
    // 平铺写法：在同一 collector 里收集，字段名仍按 layers[0].* 报告，
    // 与多层接口保持一致的错误结构。
    layers = collectLayers([{ mu: body.mu, x: body.x, material: body.material }], c, { minLayers: 1 });
  }

  const fluenceRate = validateFluenceRate(body.fluenceRate, c);
  const buildup = validateBuildup(body.buildup, c);
  c.throwIfAny();
  return { layer: layers[0], fluenceRate, buildup };
}

/**
 * 方案计算接口输入：只需要入射注量率与积累因子模式（层来自已登记方案）。
 */
export function validateSchemeCalcBody(body) {
  const c = new FieldCollector();
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    c.add('body', '必须是 JSON 对象');
    c.throwIfAny();
  }
  const fluenceRate = validateFluenceRate(body.fluenceRate, c);
  const buildup = validateBuildup(body.buildup, c);
  c.throwIfAny();
  return { fluenceRate, buildup };
}

/** 登记方案接口输入：名称可选（缺省自动生成）+ 层列表。 */
export function validateRegisterBody(body) {
  const c = new FieldCollector();
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    c.add('body', '必须是 JSON 对象');
    c.throwIfAny();
  }
  let name;
  if (body.name === undefined || body.name === null) {
    name = undefined; // 交由存储层生成
  } else if (typeof body.name !== 'string') {
    c.add('name', '必须是字符串');
  } else {
    name = body.name.trim();
    if (name.length === 0) {
      c.add('name', '不能是空白字符串');
    } else if (name.length > MAX_NAME_LENGTH) {
      c.add('name', `长度不能超过 ${MAX_NAME_LENGTH}`);
    }
  }
  const layers = collectLayers(body.layers, c);
  c.throwIfAny();
  return { name, layers };
}

/** URL 路径里的方案名。 */
export function validateNameParam(name) {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new ValidationError([{ field: 'name', message: '方案名不能为空' }]);
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new ValidationError([{ field: 'name', message: `长度不能超过 ${MAX_NAME_LENGTH}` }]);
  }
  return name;
}

/**
 * 入射注量率：缺省为 1（纯比值核算），否则必须是非负有限数。
 * @returns {number}
 */
function validateFluenceRate(raw, c) {
  if (raw === undefined) return 1;
  return c.checkFiniteNumber('fluenceRate', raw, { nonNegative: true }) ? raw : 1;
}

/**
 * 积累因子模式校验，调用方必须明确说明使用哪一种：
 *  - { mode: 'direct', value: B }，B >= 1
 *  - { mode: 'linear', coefficient: k }，k >= 0，B = 1 + k * Σ(μx)
 * 缺省（未指定）等价于 { mode: 'direct', value: 1 }，即宽束退化为窄束。
 */
function validateBuildup(raw, c) {
  if (raw === undefined) return { mode: 'direct', value: 1 };

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    c.add('buildup', "必须是 { mode: 'direct', value } 或 { mode: 'linear', coefficient }");
    return { mode: 'direct', value: 1 };
  }
  if (raw.mode === 'direct') {
    const ok = c.checkFiniteNumber('buildup.value', raw.value, { nonNegative: false });
    if (ok && raw.value < 1) {
      c.add('buildup.value', '积累因子不能小于一');
    }
    return { mode: 'direct', value: raw.value };
  }
  if (raw.mode === 'linear') {
    const ok = c.checkFiniteNumber('buildup.coefficient', raw.coefficient, { nonNegative: true });
    return { mode: 'linear', coefficient: ok ? raw.coefficient : 0 };
  }
  c.add('buildup.mode', "必须是 'direct' 或 'linear'");
  return { mode: 'direct', value: 1 };
}
