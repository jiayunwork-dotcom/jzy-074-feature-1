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
 * 校验反解接口的一层：在普通层基础上多三个可选字段——
 *  - adjustable：是否允许加厚（布尔）；
 *  - maxX：可调层允许加到的厚度上限，必须是 >= x 的有限数；
 *  - weight：可调层之间分配附加光学厚度的权重，必须为正。
 * @returns {{ material: string, mu: number, x: number, adjustable: boolean, maxX?: number, weight?: number } | null}
 */
function validateReverseLayer(layer, index, c, fieldPrefix = `layers[${index}]`) {
  const base = validateLayer(layer, index, c, fieldPrefix);
  if (layer === null || typeof layer !== 'object' || Array.isArray(layer)) return null;

  let adjustable = false;
  if (layer.adjustable !== undefined) {
    if (typeof layer.adjustable !== 'boolean') {
      c.add(`${fieldPrefix}.adjustable`, '必须是布尔值');
    } else {
      adjustable = layer.adjustable;
    }
  }

  let maxX;
  if (layer.maxX !== undefined) {
    const ok = c.checkFiniteNumber(`${fieldPrefix}.maxX`, layer.maxX, { nonNegative: true });
    if (ok) {
      if (base && layer.maxX < base.x) {
        c.add(`${fieldPrefix}.maxX`, '不能小于当前厚度 x（反解只允许加厚）');
      } else {
        maxX = layer.maxX;
      }
    }
  }

  let weight;
  if (layer.weight !== undefined) {
    const ok = c.checkFiniteNumber(`${fieldPrefix}.weight`, layer.weight, { positive: true });
    if (ok) weight = layer.weight;
  }

  if (!base) return null;
  return { ...base, adjustable, ...(maxX !== undefined ? { maxX } : {}), ...(weight !== undefined ? { weight } : {}) };
}

/** 仅收集反解层问题到给定 collector。 */
function collectReverseLayers(raw, c, { minLayers = 1 } = {}) {
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
  return raw.map((layer, i) => validateReverseLayer(layer, i, c)).filter(Boolean);
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

/**
 * 反解目标校验。两种目标：
 *  - { metric: 'broadTransmission', limit } 宽束透射率上限，必须落在 (0, 1]；
 *  - { metric: 'relativeDoseRate', limit } 相对剂量率上限，必须是 [0, 1] 内的有限数
 *    （相对剂量率无量纲时数值即宽束透射率，物理上限就是 1；0 意味着要求完全屏蔽，
 *    有限厚度下不可达，交由反解按 TARGET_UNREACHABLE 回报）。
 * limit 必须严格大于 0（透射率目标）——0 厚度永远给不出零透射。
 */
export function validateTarget(raw, c, field = 'target') {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    c.add(field, "必须是 { metric, limit }，metric 取 'broadTransmission' 或 'relativeDoseRate'");
    return { metric: 'broadTransmission', limit: 1 };
  }
  if (raw.metric !== 'broadTransmission' && raw.metric !== 'relativeDoseRate') {
    c.add(`${field}.metric`, "必须是 'broadTransmission' 或 'relativeDoseRate'");
  }
  const metric = raw.metric;
  const ok = c.checkFiniteNumber(`${field}.limit`, raw.limit, {});
  let limit = raw.limit;
  if (ok) {
    if (metric === 'broadTransmission' && (limit <= 0 || limit > 1)) {
      c.add(`${field}.limit`, '宽束透射率上限必须落在零到一之间（0 < limit <= 1）');
    }
    if (metric === 'relativeDoseRate' && (limit < 0 || limit > 1)) {
      c.add(`${field}.limit`, '相对剂量率上限不能为负，且不超过一');
    }
  }
  return { metric: metric === 'relativeDoseRate' ? 'relativeDoseRate' : 'broadTransmission', limit };
}

/**
 * 反解接口共用校验：目标 + 已归一化的层列表 + 注量率/积累因子，
 * 并补反解特有约束——至少有一层允许加厚。
 */
function finalizeReverseBody(c, layers, body) {
  const target = validateTarget(body.target, c);
  const fluenceRate = validateFluenceRate(body.fluenceRate, c);
  const buildup = validateBuildup(body.buildup, c);
  if (layers.length > 0 && !layers.some((l) => l.adjustable)) {
    c.add('layers', '反解至少需要一层标明 adjustable: true（没有可调层就无从加厚）');
  }
  c.throwIfAny();
  return { layers, target, fluenceRate, buildup };
}

/**
 * 一次性反解接口输入校验。
 * 支持 { layers: [...] } 多层写法，或单层平铺 { mu, x, adjustable, ... } / { layer: {...} }。
 */
export function validateReverseBody(body) {
  const c = new FieldCollector();
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    c.add('body', '必须是 JSON 对象');
    c.throwIfAny();
  }
  let layers;
  if (body.layer !== undefined) {
    layers = collectReverseLayers([body.layer], c, { minLayers: 1 });
  } else if (body.layers !== undefined) {
    layers = collectReverseLayers(body.layers, c);
  } else {
    // 单层平铺。
    layers = collectReverseLayers(
      [{
        mu: body.mu, x: body.x, material: body.material,
        adjustable: body.adjustable, maxX: body.maxX, weight: body.weight,
      }],
      c,
      { minLayers: 1 },
    );
  }
  return finalizeReverseBody(c, layers, body);
}

/**
 * 凭已登记方案反解的 body 校验：目标 + 可选的可调层覆盖参数。
 * 层的 μ/x 取自存储的方案；请求体可用 adjustable 数组按层下标（或 material 名）
 * 标明哪些层允许加厚，并覆盖 maxX/weight。
 * 形状：{ target, fluenceRate?, buildup?, adjustable?: number[] | string[] | Array<{index|material, maxX?, weight?}> }
 */
export function validateSchemeReverseBody(body, schemeLayers) {
  const c = new FieldCollector();
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    c.add('body', '必须是 JSON 对象');
    c.throwIfAny();
  }

  const layers = schemeLayers.map((l, i) => ({ ...l, adjustable: false }));
  const marks = body.adjustable;
  if (marks !== undefined) {
    if (!Array.isArray(marks)) {
      c.add('adjustable', '必须是数组：层下标、材料名或 {index|material, maxX?, weight?} 列表');
    } else {
      marks.forEach((mark, j) => {
        const field = `adjustable[${j}]`;
        if (typeof mark === 'number') {
          if (!Number.isInteger(mark) || mark < 0 || mark >= layers.length) {
            c.add(field, `层下标必须在 0..${layers.length - 1} 之间`);
            return;
          }
          layers[mark].adjustable = true;
        } else if (typeof mark === 'string') {
          const hit = layers.findIndex((l) => l.material === mark);
          if (hit < 0) {
            c.add(field, `方案中没有材料名为 '${mark}' 的层`);
            return;
          }
          layers[hit].adjustable = true;
        } else if (mark !== null && typeof mark === 'object') {
          let idx = -1;
          if (mark.index !== undefined) {
            if (!Number.isInteger(mark.index) || mark.index < 0 || mark.index >= layers.length) {
              c.add(`${field}.index`, `层下标必须在 0..${layers.length - 1} 之间`);
            } else {
              idx = mark.index;
            }
          } else if (typeof mark.material === 'string') {
            idx = layers.findIndex((l) => l.material === mark.material);
            if (idx < 0) c.add(`${field}.material`, `方案中没有材料名为 '${mark.material}' 的层`);
          } else {
            c.add(field, '必须给出 index 或 material');
          }
          if (idx >= 0) {
            layers[idx].adjustable = true;
            if (mark.maxX !== undefined) {
              if (c.checkFiniteNumber(`${field}.maxX`, mark.maxX, { nonNegative: true })
                && mark.maxX < layers[idx].x) {
                c.add(`${field}.maxX`, '不能小于该层当前厚度 x（反解只允许加厚）');
              } else {
                layers[idx].maxX = mark.maxX;
              }
            }
            if (mark.weight !== undefined) {
              if (c.checkFiniteNumber(`${field}.weight`, mark.weight, { positive: true })) {
                layers[idx].weight = mark.weight;
              }
            }
          }
        } else {
          c.add(field, '必须是层下标（整数）、材料名（字符串）或 {index|material, maxX?, weight?}');
        }
      });
    }
  }

  return finalizeReverseBody(c, layers, body);
}
