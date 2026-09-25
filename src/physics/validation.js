/**
 * 参数校验。校验规则集中在此处，物理模块与路由模块共用，
 * 不允许各接口各自维护一套不一致的取值范围。
 *
 * 硬性规则：
 *  - 衰减系数 mu 必须 > 0
 *  - 厚度 x 必须 >= 0
 *  - 积累因子 B 必须 >= 1（直接指定模式）
 *  - 入射注量率 fluenceRate 必须 >= 0
 *  - 反解目标限值必须 > 0；透射率上限还必须 <= 1
 *  - 反解至少要有一层标记为可调（adjustable: true）
 */
import { ValidationError } from './errors.js';
import { TARGET_METRICS } from './inverse.js';

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
 * @param {{ inverse?: boolean }} [options] inverse 模式下额外校验
 *   adjustable / maxX（反解时需要标明哪些层允许加厚、上限是多少）。
 * @returns {{ material: string, mu: number, x: number, adjustable?: boolean, maxX?: number } | null}
 */
function validateLayer(layer, index, c, fieldPrefix = `layers[${index}]`, { inverse = false } = {}) {
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

  let adjustable = false;
  let maxX = undefined;
  if (inverse) {
    if (layer.adjustable !== undefined && typeof layer.adjustable !== 'boolean') {
      c.add(`${fieldPrefix}.adjustable`, '必须是布尔值');
    }
    adjustable = layer.adjustable === true;

    if (layer.maxX !== undefined && layer.maxX !== null) {
      if (!adjustable) {
        // 不允许加厚的层给出 maxX 语义含糊，显式拒绝。
        c.add(`${fieldPrefix}.maxX`, '只能在 adjustable 为 true 的层上指定厚度上限');
      } else {
        const maxOk = c.checkFiniteNumber(`${fieldPrefix}.maxX`, layer.maxX, { nonNegative: true });
        if (maxOk) {
          if (xOk && layer.maxX < layer.x) {
            c.add(`${fieldPrefix}.maxX`, '不能小于该层当前厚度 x');
          } else {
            maxX = layer.maxX;
          }
        }
      }
    }
  }

  if (!(muOk && xOk)) return null;
  return {
    material: material ?? `layer-${index + 1}`,
    mu: layer.mu,
    x: layer.x,
    ...(inverse ? { adjustable, maxX: adjustable ? (maxX ?? Infinity) : undefined } : {}),
  };
}

/**
 * 校验并归一化层列表。
 * @param {any} raw
 * @param {{ minLayers?: number, inverse?: boolean }} [options]
 * @returns {{ material: string, mu: number, x: number, adjustable?: boolean, maxX?: number }[]}
 */
export function validateLayers(raw, { minLayers = 1, inverse = false } = {}) {
  const c = new FieldCollector();
  const layers = collectLayers(raw, c, { minLayers, inverse });
  c.throwIfAny();
  return layers;
}

/** 仅收集层问题到给定 collector，供需要聚合其它字段错误的接口复用。 */
function collectLayers(raw, c, { minLayers = 1, inverse = false } = {}) {
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
  const layers = raw
    .map((layer, i) => validateLayer(layer, i, c, `layers[${i}]`, { inverse }))
    .filter(Boolean);
  if (inverse && Array.isArray(raw) && raw.length >= minLayers && !layers.some((l) => l.adjustable)) {
    c.add('layers', '反解至少需要一层标记 adjustable: true（允许加厚的层集合不能为空）');
  }
  return layers;
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
 * 反解目标校验：给一条不能越过的上限，反求达标所需最小厚度。
 *  - target.metric：'broadTransmission'（宽束透射率上限，0 < limit <= 1）
 *    或 'relativeDoseRate'（屏蔽后相对剂量率上限，limit > 0；>1 意味着
 *    零厚度即达标）。
 *  - 限值必须为正有限数：指数衰减在任何有限厚度下都严格为正，0 与负值
 *    在物理上不可达，不能让反解去追逐无穷大厚度。
 */
function validateTarget(raw, c) {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    c.add('target', "必须是 { metric, limit }，metric 取 'broadTransmission' 或 'relativeDoseRate'");
    return { metric: 'broadTransmission', limit: 1 };
  }
  let metric = raw.metric;
  if (metric === undefined) metric = 'broadTransmission';
  if (!TARGET_METRICS.includes(metric)) {
    c.add('target.metric', "必须是 'broadTransmission' 或 'relativeDoseRate'");
  }

  const limitField = 'target.limit';
  const limitOk = c.checkFiniteNumber(limitField, raw.limit, { nonNegative: false });
  if (limitOk && raw.limit <= 0) {
    c.add(limitField, '目标限值必须严格大于零（有限厚度下透射率恒为正，零或负值不可达）');
  }
  // 透射率的取值区间就是 (0,1]：上限超过 1 没有物理意义。
  if (limitOk && raw.limit > 1 && metric === 'broadTransmission') {
    c.add(limitField, '透射率上限必须在零到一之间（含一）');
  }

  return { metric: TARGET_METRICS.includes(metric) ? metric : 'broadTransmission', limit: raw.limit };
}

/**
 * 一次性反解接口输入（无需登记方案）：
 * { layers: [{ mu, x, material?, adjustable, maxX? }],
 *   target: { metric, limit }, fluenceRate?, buildup? }
 * 也支持 { layer: {...}, ... } 的单层包裹写法。
 */
export function validateInverseBody(body) {
  const c = new FieldCollector();
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    c.add('body', '必须是 JSON 对象');
    c.throwIfAny();
  }
  let layers;
  if (body.layer !== undefined) {
    layers = collectLayers([body.layer], c, { minLayers: 1, inverse: true });
    if (Array.isArray(body.layers)) c.add('layers', "不能同时给出 layer 与 layers");
  } else {
    layers = collectLayers(body.layers, c, { minLayers: 1, inverse: true });
  }
  const target = validateTarget(body.target, c);
  const fluenceRate = validateFluenceRate(body.fluenceRate, c);
  const buildup = validateBuildup(body.buildup, c);
  c.throwIfAny();
  return { layers, target, fluenceRate, buildup };
}

/**
 * 具名方案反解接口输入：层结构来自已登记方案，请求只声明目标、
 * 允许加厚的层（按层序号引用，可附带 maxX）与积累因子模式。
 */
export function validateSchemeInverseBody(body) {
  const c = new FieldCollector();
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    c.add('body', '必须是 JSON 对象');
    c.throwIfAny();
  }
  let adjustable = [];
  if (body.adjustable === undefined || body.adjustable === null) {
    c.add('adjustable', '必须是非空数组，列出允许加厚的层序号（从 0 开始）');
  } else if (!Array.isArray(body.adjustable)) {
    c.add('adjustable', '必须是层序号数组（从 0 开始）');
  } else if (body.adjustable.length === 0) {
    c.add('adjustable', '允许加厚的层集合不能为空');
  } else {
    const seen = new Set();
    adjustable = body.adjustable.map((item, i) => {
      const field = `adjustable[${i}]`;
      let index;
      let maxX;
      if (
        item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        (item.index !== undefined || item.layer !== undefined)
      ) {
        index = item.index ?? item.layer;
        if (item.maxX !== undefined && item.maxX !== null) {
          if (!c.checkFiniteNumber(`${field}.maxX`, item.maxX, { nonNegative: true })) maxX = undefined;
          else maxX = item.maxX;
        }
      } else {
        index = item;
      }
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
        c.add(field, '必须是非负整数层序号（从 0 开始）');
        return null;
      }
      if (seen.has(index)) {
        c.add(field, `层序号 ${index} 重复出现`);
      }
      seen.add(index);
      return { index, maxX };
    }).filter(Boolean);
  }
  const target = validateTarget(body.target, c);
  const fluenceRate = validateFluenceRate(body.fluenceRate, c);
  const buildup = validateBuildup(body.buildup, c);
  c.throwIfAny();
  return { adjustable, target, fluenceRate, buildup };
}

/**
 * 把请求里的可调层引用解析到已登记方案的层上：序号越界、maxX 小于
 * 该层已登记厚度等跨字段问题在此一并拦下。
 * @param {{material?:string,mu:number,x:number}[]} schemeLayers
 * @param {{index:number, maxX?:number}[]} adjustable
 * @returns {object[]} 带 adjustable / maxX 标记的完整层列表
 */
export function resolveAdjustableLayers(schemeLayers, adjustable) {
  const c = new FieldCollector();
  const byIndex = new Map(adjustable.map((a) => [a.index, a]));
  const layers = schemeLayers.map((l, i) => {
    const ref = byIndex.get(i);
    if (!ref) return { ...l, adjustable: false };
    if (ref.maxX !== undefined && ref.maxX < l.x) {
      c.add(`adjustable[${i}].maxX`, `不能小于第 ${i} 层已登记的厚度 x=${l.x}`);
    }
    return { ...l, adjustable: true, maxX: ref.maxX ?? Infinity };
  });
  for (const ref of adjustable) {
    if (ref.index >= schemeLayers.length) {
      c.add('adjustable', `层序号 ${ref.index} 越界，方案共 ${schemeLayers.length} 层`);
    }
  }
  c.throwIfAny();
  return layers;
}
