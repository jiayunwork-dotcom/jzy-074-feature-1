/**
 * 积累因子处理，单独成块。
 *
 * 宽束（坏几何）透射率在窄束指数衰减上再乘一个积累因子 B：
 *   T_broad = B · exp(-Σ μᵢxᵢ),  B >= 1
 * B = 1 时宽束退化为窄束。
 *
 * 两种模式，调用方必须明确指定：
 *  1. direct：调用方直接给数值，B = value（value >= 1）；
 *  2. linear：线性近似，B = 1 + k · Σ(μᵢxᵢ)。
 *
 * 多层屏蔽时，积累因子取最外层（离源最远、离探测器最近那一层）
 * 材料对应的值；线性模式下线性系数 k 按最外层材料取用，
 * 乘的是全部层的衰减厚度之和（总光学厚度），而不是只乘最外层。
 */
import { UnphysicalResultError } from './errors.js';

/**
 * 计算积累因子。
 * @param {{mode:'direct', value:number} | {mode:'linear', coefficient:number}} spec
 * @param {number} totalOpticalDepth Σ μᵢxᵢ（总衰减厚度，无量纲）
 * @param {{ material: string, mu: number } | undefined} outerLayer
 *   最外层材料信息，多层时用于表明 B 取自哪一层。
 * @returns {{ value: number, basis: { mode: string, outerLayer: string|undefined, totalOpticalDepth: number } }}
 */
export function resolveBuildup(spec, totalOpticalDepth, outerLayer = undefined) {
  const basis = {
    mode: spec.mode,
    outerLayer: outerLayer?.material,
    outerMu: outerLayer?.mu,
    totalOpticalDepth,
  };

  if (spec.mode === 'direct') {
    // 零厚度不衰减：无论调用方给的 B 是多少，物理上没有屏蔽体可产生散射积累。
    // 见 attenuation 物理约束：x=0 时透射率必须精确为 1。
    if (totalOpticalDepth === 0) return { value: 1, basis };
    return { value: spec.value, basis };
  }

  // linear：B = 1 + k · Σ(μᵢxᵢ)
  const value = 1 + spec.coefficient * totalOpticalDepth;
  if (value < 1 - Number.EPSILON) {
    throw new UnphysicalResultError('线性近似算得的积累因子小于一', {
      coefficient: spec.coefficient,
      totalOpticalDepth,
      buildup: value,
    });
  }
  return { value: Math.max(1, value), basis };
}
