/**
 * 多层屏蔽叠加逻辑。
 *
 * 关键规则：各层的 μᵢxᵢ 必须逐层相加、对总和统一取一次指数：
 *   T_narrow = exp(- Σᵢ μᵢxᵢ )
 * 不能先分层算透射率再相乘（Πᵢ exp(-μᵢxᵢ)）——浮点运算里
 * 两种算法会出现 ULP 级差异，后者把每一步的舍入误差逐层累积。
 *
 * 积累因子取最外层（layers 的最后一层，即离探测器最近的一层）
 * 材料对应的值。
 */
import { narrowTransmission, halfValueLayer, tenthValueLayer } from './attenuation.js';
import { resolveBuildup } from './buildup.js';
import { UnphysicalResultError } from './errors.js';

/**
 * @typedef {{ material?: string, mu: number, x: number }} ShieldLayer
 */

/** Σ μᵢxᵢ —— 只做一次求和，供统一指数使用。 */
export function totalOpticalDepth(layers) {
  let sum = 0;
  for (const { mu, x } of layers) sum += mu * x;
  return sum;
}

/** 物理合理性护栏：透射率不得为负、不得超过一（允许 1 ULP 的舍入余量）。 */
function assertPhysicalTransmission(label, value) {
  if (!Number.isFinite(value) || value < 0) {
    throw new UnphysicalResultError(`${label} 为负或非有限值`, { transmission: value });
  }
  if (value > 1 + Number.EPSILON) {
    throw new UnphysicalResultError(`${label} 超过一（透射率不应大于入射值）`, {
      transmission: value,
    });
  }
}

/**
 * 对一套屏蔽结构做一次完整核算。单层接口与方案接口都走这里。
 *
 * @param {ShieldLayer[]} layers 已通过校验的层（从源到探测器排序，最后一层为最外层）
 * @param {{
 *   fluenceRate?: number,
 *   buildup?: {mode:'direct', value:number} | {mode:'linear', coefficient:number},
 * }} [options]
 * @returns {object} 透射率与相对剂量率等完整结果
 */
export function evaluateShielding(layers, options = {}) {
  const fluenceRate = options.fluenceRate ?? 1;
  const buildupSpec = options.buildup ?? { mode: 'direct', value: 1 };

  const opticalDepth = totalOpticalDepth(layers);
  const outerLayer = layers.length > 0 ? layers[layers.length - 1] : undefined;

  // 统一指数：对 Σμᵢxᵢ 只取一次 exp。
  const narrow = narrowTransmission(1, opticalDepth);

  const { value: buildupFactor, basis } = resolveBuildup(
    buildupSpec,
    opticalDepth,
    outerLayer,
  );

  let broad = buildupFactor * narrow;
  // 纯舍入造成的 <= 1 ULP 越界钳回 1，其余超界一律按非物理结果拒绝。
  if (opticalDepth === 0) {
    broad = 1; // 零厚度：不衰减，且无屏蔽体产生散射积累。
  } else if (broad > 1 && broad <= 1 + Number.EPSILON) {
    broad = 1;
  }

  assertPhysicalTransmission('窄束透射率', narrow);
  assertPhysicalTransmission('宽束透射率', broad);

  // 等效衰减系数：把整套多层结构折算成同一厚度下的单一 μ。
  const totalThickness = layers.reduce((s, l) => s + l.x, 0);
  const effectiveMu = totalThickness > 0 ? opticalDepth / totalThickness : 0;

  return {
    layerCount: layers.length,
    layers: layers.map((l, i) => ({
      index: i,
      material: l.material,
      mu: l.mu,
      x: l.x,
      opticalDepth: l.mu * l.x,
      hvl: halfValueLayer(l.mu),
      tvl: tenthValueLayer(l.mu),
    })),
    totalThickness,
    totalOpticalDepth: opticalDepth,
    effectiveMu,
    // 半值层/十值层：逐层给出材料自身的值；顶层给出整套结构的等效值。
    hvl: effectiveMu > 0 ? halfValueLayer(effectiveMu) : null,
    tvl: effectiveMu > 0 ? tenthValueLayer(effectiveMu) : null,
    buildupFactor,
    buildupBasis: basis,
    // 窄束：纯指数；宽束/总透射率：含积累因子；两者均为无量纲比值。
    narrowTransmission: narrow,
    broadTransmission: broad,
    totalTransmission: broad,
    // 相对剂量率：透射后 / 入射。辐射剂量率正比于光子注量率，
    // 因此相对剂量率在数值上等于（宽束）透射率。
    relativeDoseRate: broad,
    incidentFluenceRate: fluenceRate,
    transmittedFluenceRate: fluenceRate * broad,
  };
}
