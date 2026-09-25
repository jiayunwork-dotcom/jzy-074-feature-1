/**
 * 核心衰减公式。指数衰减、半值层、十值层集中在此，
 * 单层接口与多层/方案接口都只允许调用这里的公式，不各自维护一份。
 *
 * 窄束透射（不考虑散射光子重新进入探测方向）：
 *   T_narrow = exp(-μ · x)
 *
 * 半值层（透射率降到一半的厚度）：HVL = ln2 / μ
 * 十值层（透射率降到十分之一的厚度）：TVL = ln10 / μ
 * 这两个值只由衰减系数 μ 决定，与入射注量率、积累因子无关。
 */

/**
 * 窄束（好几何）透射率。
 * 前置条件（由 validation 模块保证）：mu > 0，x >= 0。
 * @param {number} mu 线性衰减系数（1/单位厚度）
 * @param {number} x 屏蔽厚度（与 μ 倒数同量纲）
 * @returns {number} (0, 1]
 */
export function narrowTransmission(mu, x) {
  return Math.exp(-mu * x);
}

/**
 * 半值层厚度 HVL = ln2 / μ。
 * @param {number} mu
 * @returns {number}
 */
export function halfValueLayer(mu) {
  return Math.LN2 / mu;
}

/**
 * 十值层厚度 TVL = ln10 / μ。
 * @param {number} mu
 * @returns {number}
 */
export function tenthValueLayer(mu) {
  return Math.LN10 / mu;
}
