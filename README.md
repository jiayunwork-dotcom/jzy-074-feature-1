# 辐射屏蔽核算服务（Radiation Shielding Service）

把核医学 / 工业探伤防护设计中常用的屏蔽换算钉死的 HTTP 服务：给屏蔽材料、
厚度与入射注量率，返回窄束/宽束透射率、半值层（HVL）、十值层（TVL）、
总透射率与相对剂量率。支持多层屏蔽叠加、积累因子两种取法、具名方案
登记复用，以及**按目标限值反求达标所需的最小屏蔽厚度**。Node.js 20 +
Fastify + 容器内 SQLite（better-sqlite3）。

## 物理模型

**窄束（好几何）透射**——纯指数衰减，不考虑散射光子重新进入探测方向：

```
T_narrow = exp(-μ · x)
```

**宽束（坏几何）透射**——在窄束结果上乘积累因子 B（B ≥ 1，B=1 时退化为窄束）：

```
T_broad = B · T_narrow
```

**半值层 / 十值层**（只由衰减系数 μ 决定，与入射注量率、积累因子无关）：

```
HVL = ln2 / μ      （透射率降到一半的厚度）
TVL = ln10 / μ     （透射率降到十分之一的厚度）
```

**多层屏蔽**——各层衰减厚度先求和，再对总和统一取一次指数：

```
T_narrow = exp(- Σᵢ μᵢxᵢ )
```

不采用「先分层算透射率再相乘」`Πᵢ exp(-μᵢxᵢ)`：浮点运算中两算法有 ULP 级
差异，后者逐层累积舍入误差。`test/multilayer.test.js` 用一组确定性取值
（μ₁=0.5,x₁=0.5,μ₂=1,x₂=2，两结果差恰好 1 ULP = 2⁻⁵⁶）钉死了这一区别。

**积累因子的两种模式**（调用方必须显式指定）：

| 模式 | 请求体 | 公式 |
|---|---|---|
| 直接指定 | `{"mode":"direct","value":B}` | B 为给定值，必须 ≥ 1 |
| 线性近似 | `{"mode":"linear","coefficient":k}` | B = 1 + k · Σᵢμᵢxᵢ |

多层时积累因子取**最外层**（层列表最后一层，即离探测器最近的一层）材料
对应的值；线性模式下系数 k 按最外层材料取用，乘的是全部层的总光学厚度。
响应里的 `buildupBasis` 会标明取自哪一层、总光学厚度是多少。

**零厚度**：x=0（或 Σμᵢxᵢ=0）时没有屏蔽体产生散射积累，无论给的 B 是多少，
透射率严格等于 1。

**相对剂量率**：剂量率正比于光子注量率，因此相对剂量率在数值上等于宽束
透射率；`transmittedFluenceRate = incidentFluenceRate · T_broad`。

### 反求最小厚度（按目标限值倒推）

防护设计的常态是先有限值（墙外剂量率/透射率不得高于某值），再倒着定厚度。
反解回答「最少要砌多厚」，而不是拿计算器一层层试：

```
给定 target（metric + limit）与层结构（标明哪些层可调、各层厚度上限 maxX），
求使 forward 指标 ≤ limit 的最小厚度配置，并代回 evaluateShielding() 复核。
```

反解**不另抄衰减公式**：它只以总光学厚度 y = Σμᵢxᵢ 为自变量调用同一个
`evaluateShielding()`（μ=1 的虚拟单层）取值，因此反解与正向核算口径必然
一致，不可能出现「反解说达标、正向算出来越限」。

为什么不能把正向公式移项取对数：

- `direct` 模式 T(y)=B·e⁻ʸ 尚可解析取对数；
- `linear` 模式 T(y)=(1+k·y)·e⁻ʸ **先增后减**——在 y=(k−1)/k 处有峰值
  k·e^(−(k−1)/k)，k>1 时小厚度区段 T 甚至 >1（被物理护栏判为非物理）。
  直接解析求逆会取到错误的那一支（如 k=2、限值 0.5 时，朴素对数解
  y=ln2 处 T≈1.19，根本不达标；正确根在下降支 y≈2.48）。

因此反解统一用「基线判定 → 倍增括界（跳过非物理区段）→ 二分求根」数值
求解，两种积累因子模式走同一条路；二分夹到 1e-15 相对精度后再向更厚侧
加一次 ~1e-12 相对量级的微量，保证代回正向核算的指标**严格落在限值内侧**
（该增量比任何可感知削薄都低几个数量级，不影响最小性）。

**多层部分层固定**：指标只取决于总光学厚度，固定层与可调层已有厚度的
贡献先计入 y0，再在可调层间按 μ 从大到小贪心分配增量（μ 越大每单位
光学厚度越省物理厚度），带 `maxX` 的层依次填满。**全部可调层顶到上限
仍压不到目标时**，返回 422 `TARGET_UNREACHABLE`，不返回越限厚度或
无穷大。

## 接口（仅 HTTP，无界面）

### 1. 一次性单层核算（无需登记）

```
POST /calculate
{ "material": "Pb", "mu": 0.577, "x": 1.2,
  "fluenceRate": 1000,                          // 可选，缺省 1
  "buildup": {"mode": "linear", "coefficient": 0.3} }  // 可选，缺省 B=1
```

层参数也可用 `{"layer": {"mu", "x", "material?"}, ...}` 包裹。省略 `buildup`
等价于 `{"mode":"direct","value":1}`。

### 2. 登记屏蔽方案

```
POST /schemes
{ "name": "reactor-wall",          // 可选；省略自动生成 scheme-<uuid>
  "layers": [ {"material":"Pb","mu":2,"x":1},
              {"material":"concrete","mu":0.5,"x":4} ] }
→ 201 { "name": "reactor-wall", ... }
```

配套：`GET /schemes`（列表）、`GET /schemes/:name`（详情）。重复名字返回 409。

### 3. 凭方案名 + 入射注量率反复核算

```
POST /schemes/:name/calculate
{ "fluenceRate": 5000,
  "buildup": {"mode": "direct", "value": 2.1} }
```

层结构只登记一次，之后可换不同入射源（注量率）反复算，互不影响。

### 4. 一次性反解：给目标限值，反求最小厚度（无需登记）

```
POST /inverse
{ "layers": [ {"material":"concrete","mu":0.5,"x":4},                    // 固定层
              {"material":"Pb","mu":2,"x":0,"adjustable":true,"maxX":5} ], // 可调层
  "target": {"metric":"broadTransmission","limit":0.01},
  "fluenceRate": 1000,                          // 可选，缺省 1
  "buildup": {"mode":"linear","coefficient":0.3} }  // 可选，缺省 B=1
```

- `target.metric`：`broadTransmission`（宽束透射率上限，0 < limit ≤ 1）或
  `relativeDoseRate`（屏蔽后相对剂量率上限，limit > 0；>1 表示零厚度即达标）。
  限值必须为正有限数——指数衰减在任何有限厚度下都严格为正，0 与负值
  物理上不可达，按 400 拒绝。
- 至少一层 `adjustable: true`；`maxX` 只能给可调层，必须非负且不小于
  该层当前厚度，缺省表示不封顶。单层场景可用 `{"layer": {...}, ...}` 包裹。

### 5. 凭已登记具名方案反解

```
POST /schemes/:name/inverse
{ "target": {"metric":"broadTransmission","limit":0.01},
  "adjustable": [1, {"index":2,"maxX":8}],   // 层序号（从0）或带上限的对象
  "buildup": {"mode":"direct","value":1} }
```

沿用方案里存好的层结构，只在 `adjustable` 列出的层上求增量，其余层
厚度固定（其衰减贡献先扣除）。`adjustable` 不能为空、序号不得越界或重复。

### 反解响应

`feasible`、`target`、`achievedMetric`（达标后的指标值）、
`baselineFeasible`（既有厚度是否已达标）、`addedOpticalDepth`、
`totalOpticalDepth`、逐层 `x/initialX/addedX/adjustable/maxX`，以及
`forward`——把反解厚度代回 `evaluateShielding()` 的**完整正向核算结果**
（窄束/宽束透射率、相对剂量率、出射注量率、HVL/TVL 等），调用方一眼
看清方案确实压在限值以内。

### 响应字段

`narrowTransmission`、`broadTransmission`（=`totalTransmission`）、
`relativeDoseRate`、`incidentFluenceRate`、`transmittedFluenceRate`、
`buildupFactor`、`buildupBasis`、总/逐层 `hvl` 与 `tvl`、`totalOpticalDepth`、
`effectiveMu`、逐层 μx 明细。

### 内置示范方案（启动自动登记，幂等）

| 方案名 | 含义 |
|---|---|
| `demo-co60-pb-hvl` | Co-60（~1.25 MeV）铅 HVL≈1.2 cm |
| `demo-cs137-pb-hvl` | Cs-137（0.662 MeV）铅 HVL≈0.65 cm |
| `demo-ir192-pb-hvl` | Ir-192（~0.38 MeV）铅 HVL≈0.6 cm |
| `demo-pb-unit-hvl` | 精确自检：μ=ln2,x=1 → 窄束透射率**位精确** 0.5 |
| `demo-pb-unit-tvl` | 精确自检：μ=ln10,x=1 → 窄束透射率 0.1（1 ULP 内） |

> 关于「精确」：IEEE-754 下 `exp(-ln2)===0.5` 严格成立，而
> `exp(-ln10)=0.09999999999999998`（0.1 无精确二进制表示，任何 μ 都差
> 1 ULP）。公式是精确的，差异纯粹是浮点舍入，测试据此分别用严格相等与
> `Number.EPSILON` 断言。

### 错误响应（结构化）

```json
{ "error": true, "code": "VALIDATION_ERROR", "message": "参数校验失败",
  "details": [ {"field": "layers[0].mu", "message": "必须大于零"}, ... ] }
```

| HTTP | code | 触发条件 |
|---|---|---|
| 400 | `VALIDATION_ERROR` | μ≤0、x<0、B<1、注量率<0、模式非法、目标限值越出物理可达区间、无可调层等，一次返回全部问题字段 |
| 400 | `BAD_REQUEST` | JSON 解析失败 |
| 404 | `SCHEME_NOT_FOUND` | 方案名不存在 |
| 409 | `SCHEME_ALREADY_EXISTS` | 方案名重复 |
| 422 | `UNPHYSICAL_RESULT` | 模型给出透射率 <0 或 >1（不允许当正常结果返回） |
| 422 | `TARGET_UNREACHABLE` | 反解时全部可调层顶到厚度上限仍压不到目标限值 |

例如直接指定的 B 在极薄屏蔽处使 B·T > 1 时，服务返回 422 而不是一个
超过 1 的透射率。线性近似在 0 ≤ k ≤ 1 时恒有 (1+ky)e⁻ʸ ≤ 1。

## 运行

```bash
# 本地
npm install
npm test          # node --test，94 个用例
npm start         # 默认 :3000，DB 在 ./data/shield.sqlite

# Docker（构建阶段会先跑测试）
docker build -t shield-service .
docker run --rm -p 3000:3000 -v "$PWD/data:/data" shield-service

# 配置
PORT=3000  HOST=0.0.0.0  DB_PATH=/data/shield.sqlite
```

健康检查：`GET /healthz`。

## 代码结构

```
src/
  physics/
    attenuation.js   核心：exp(-μx)、HVL=ln2/μ、TVL=ln10/μ（唯一公式来源）
    buildup.js       积累因子：direct / linear 两种模式
    multilayer.js    多层叠加（Σμx 统一取指数）+ 完整核算入口 + 物理护栏
    inverse.js       反求最小厚度：括界+二分求根、可调层贪心分配、不可达判定
    validation.js    参数校验（规则集中一处，聚合所有错误字段）
    errors.js        结构化错误类型
  storage/
    schemes.js       方案登记/取用（SQLite），独立模块
    demos.js         内置示范方案数据
  routes.js          HTTP 路由
  app.js             Fastify 装配 + 错误处理
  index.js           启动入口
test/                node:test 物理/多层/校验/存储/反解/HTTP 用例
```

单层接口与方案接口都调用 `evaluateShielding()`，衰减公式只有
`attenuation.js` 一份，不会出现两套不一致的实现；**反解模块也只以
光学厚度为自变量复用同一个 `evaluateShielding()`，绝不另抄衰减公式**。
方案存取是同步 SQLite 调用，配合 Node 单线程事件循环，请求间不会把
甲方案的厚度串进乙方案；并发隔离有专门测试（30 个方案并发登记 +
交错核算）。

反解的关键性质由 `test/inverse.test.js` / `test/http-inverse.test.js`
钉死：反解厚度代回正向核算确实不超限（round-trip 自洽）；把反解厚度
再削掉一丁点（1e-9/1e-7 相对）必然越限（确为最小达标厚度）；direct 与
linear（含 k>1 非单调）两种模式都成立；多层部分固定时固定层贡献被
正确扣除；封顶不可达返回 422 而不是越限厚度；非法限值返回 400。

## 快速核对

```bash
curl -s -X POST localhost:3000/schemes/demo-pb-unit-hvl/calculate \
  -H 'content-type: application/json' -d '{"fluenceRate":1000}'
# narrowTransmission 严格 0.5，transmittedFluenceRate 500

# 反解：宽束透射率压到 0.1 以下，铅最少要砌多厚（μ=0.577 cm⁻¹，B=1）
curl -s -X POST localhost:3000/inverse -H 'content-type: application/json' -d '{
  "layers":[{"material":"Pb","mu":0.577,"x":0,"adjustable":true}],
  "target":{"metric":"broadTransmission","limit":0.1}}'
# layers[0].x ≈ 3.99 cm（恰为 1 个 TVL），achievedMetric ≈ 0.0999999… 严格 ≤ 0.1
```
