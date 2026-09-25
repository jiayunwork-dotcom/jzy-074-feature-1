# 辐射屏蔽核算服务（Radiation Shielding Service）

把核医学 / 工业探伤防护设计中常用的屏蔽换算钉死的 HTTP 服务：给屏蔽材料、
厚度与入射注量率，返回窄束/宽束透射率、半值层（HVL）、十值层（TVL）、
总透射率与相对剂量率。支持多层屏蔽叠加、积累因子两种取法，以及具名方案
登记复用。Node.js 20 + Fastify + 容器内 SQLite（better-sqlite3）。

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
| 400 | `VALIDATION_ERROR` | μ≤0、x<0、B<1、注量率<0、模式非法等，一次返回全部问题字段 |
| 400 | `BAD_REQUEST` | JSON 解析失败 |
| 404 | `SCHEME_NOT_FOUND` | 方案名不存在 |
| 409 | `SCHEME_ALREADY_EXISTS` | 方案名重复 |
| 422 | `UNPHYSICAL_RESULT` | 模型给出透射率 <0 或 >1（不允许当正常结果返回） |

例如直接指定的 B 在极薄屏蔽处使 B·T > 1 时，服务返回 422 而不是一个
超过 1 的透射率。线性近似在 0 ≤ k ≤ 1 时恒有 (1+ky)e⁻ʸ ≤ 1。

## 运行

```bash
# 本地
npm install
npm test          # node --test，51 个用例
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
    validation.js    参数校验（规则集中一处，聚合所有错误字段）
    errors.js        结构化错误类型
  storage/
    schemes.js       方案登记/取用（SQLite），独立模块
    demos.js         内置示范方案数据
  routes.js          HTTP 路由
  app.js             Fastify 装配 + 错误处理
  index.js           启动入口
test/                node:test 物理/多层/校验/存储/并发/HTTP 用例
```

单层接口与方案接口都调用 `evaluateShielding()`，衰减公式只有
`attenuation.js` 一份，不会出现两套不一致的实现。方案存取是同步 SQLite
调用，配合 Node 单线程事件循环，请求间不会把甲方案的厚度串进乙方案；
并发隔离有专门测试（30 个方案并发登记 + 交错核算）。

## 快速核对

```bash
curl -s -X POST localhost:3000/schemes/demo-pb-unit-hvl/calculate \
  -H 'content-type: application/json' -d '{"fluenceRate":1000}'
# narrowTransmission 严格 0.5，transmittedFluenceRate 500
```
