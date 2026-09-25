/**
 * 内置示范方案：常见放射源 γ 射线在铅中的半值层（HVL）数据。
 * 登记好可直接核对模型算得对不对——取厚度为一个 HVL 时，
 * 窄束透射率应当落在 0.5（参考值方案受表格舍入影响在 0.5 附近，
 * demo-*-unit 系列用精确 μ 构造，透射率严格为 0.5 / 0.1）。
 *
 * μ 由表列 HVL 反推：μ = ln2 / HVL。
 * 厚度单位 cm，μ 单位 cm⁻¹。
 */
const cm = 1;

function fromHvl(hvlCm) {
  return { mu: Math.LN2 / hvlCm, x: hvlCm * cm };
}

export const DEMO_SCHEMES = [
  {
    // Co-60 平均 γ 能量约 1.25 MeV，铅 HVL 约 1.2 cm。
    name: 'demo-co60-pb-hvl',
    description: 'Co-60 铅层一个半值层（参考值，HVL≈1.2 cm，μ=ln2/HVL）',
    layers: [{ material: 'Pb', ...fromHvl(1.2) }],
  },
  {
    // Cs-137 的 0.662 MeV γ，铅 HVL 约 0.65 cm。
    name: 'demo-cs137-pb-hvl',
    description: 'Cs-137 铅层一个半值层（参考值，HVL≈0.65 cm）',
    layers: [{ material: 'Pb', ...fromHvl(0.65) }],
  },
  {
    // Ir-192 平均 γ 能量约 0.38 MeV，铅 HVL 约 0.6 cm（不同表取值 0.55~0.6 cm）。
    name: 'demo-ir192-pb-hvl',
    description: 'Ir-192 铅层一个半值层（参考值，HVL≈0.6 cm）',
    layers: [{ material: 'Pb', ...fromHvl(0.6) }],
  },
  {
    // 精确自检：μ=ln2、x=1，exp(-μx)=exp(-ln2) 在 IEEE-754 下严格等于 0.5。
    name: 'demo-pb-unit-hvl',
    description: '精确半值层自检：μ=ln2, x=1 → 窄束透射率严格等于 1/2',
    layers: [{ material: 'Pb-unit', mu: Math.LN2, x: 1 }],
  },
  {
    // 精确自检：μ=ln10、x=1，exp(-μx) 在机器精度（1 ULP）内等于 0.1。
    name: 'demo-pb-unit-tvl',
    description: '精确十值层自检：μ=ln10, x=1 → 窄束透射率等于 1/10（机器精度内）',
    layers: [{ material: 'Pb-unit', mu: Math.LN10, x: 1 }],
  },
];
