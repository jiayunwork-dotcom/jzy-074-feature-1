/**
 * HTTP 端到端测试：三类接口 + 结构化错误 + 并发互不串改。
 * 通过 Fastify inject 发请求，不占端口；每个文件用独立内存库。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

let app;

before(async () => {
  app = await buildApp({ dbPath: ':memory:', seed: true, logger: false });
});
after(async () => {
  await app.close();
});

test('GET /healthz', async () => {
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
});

test('一次性单层核算 POST /calculate：窄束/宽束/HVL/TVL/相对剂量率齐全', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/calculate',
    payload: { mu: Math.LN2, x: 1, material: 'Pb', fluenceRate: 200, buildup: { mode: 'direct', value: 1 } },
  });
  assert.equal(res.statusCode, 200);
  const b = res.json();
  assert.equal(b.narrowTransmission, 0.5);
  assert.equal(b.broadTransmission, 0.5);
  assert.equal(b.totalTransmission, 0.5);
  assert.equal(b.relativeDoseRate, 0.5);
  assert.equal(b.transmittedFluenceRate, 100);
  assert.equal(b.hvl, 1);
  assert.ok(Math.abs(b.tvl - Math.LN10 / Math.LN2) < Number.EPSILON);
  assert.equal(b.layerCount, 1);
});

test('POST /calculate 支持 layer 包裹，也支持 mu/x 平铺；缺省 B=1、注量率=1', async () => {
  const r1 = await app.inject({
    method: 'POST',
    url: '/calculate',
    payload: { layer: { mu: 1, x: 2 } },
  });
  assert.equal(r1.statusCode, 200);
  assert.equal(r1.json().narrowTransmission, Math.exp(-2));
  assert.equal(r1.json().incidentFluenceRate, 1);
  assert.equal(r1.json().buildupFactor, 1);

  const r2 = await app.inject({
    method: 'POST',
    url: '/calculate',
    payload: { mu: 1, x: 2, buildup: { mode: 'linear', coefficient: 0.25 } },
  });
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.json().buildupFactor, 1.5);
  assert.equal(r2.json().broadTransmission, 1.5 * Math.exp(-2));
});

test('登记方案 → 凭名核算 → 换注量率再算', async () => {
  const reg = await app.inject({
    method: 'POST',
    url: '/schemes',
    payload: {
      name: 'http-wall',
      layers: [
        { material: 'Pb', mu: 2, x: 1 },
        { material: 'concrete', mu: 0.5, x: 4 },
      ],
    },
  });
  assert.equal(reg.statusCode, 201);
  assert.equal(reg.json().name, 'http-wall');

  const calc1 = await app.inject({
    method: 'POST',
    url: '/schemes/http-wall/calculate',
    payload: { fluenceRate: 500, buildup: { mode: 'direct', value: 1 } },
  });
  assert.equal(calc1.statusCode, 200);
  const c1 = calc1.json();
  assert.equal(c1.scheme, 'http-wall');
  assert.equal(c1.totalOpticalDepth, 4);
  assert.equal(c1.narrowTransmission, Math.exp(-4));
  assert.equal(c1.transmittedFluenceRate, 500 * Math.exp(-4));
  assert.equal(c1.buildupBasis.outerLayer, 'concrete');

  const calc2 = await app.inject({
    method: 'POST',
    url: '/schemes/http-wall/calculate',
    payload: { fluenceRate: 9000, buildup: { mode: 'linear', coefficient: 0.3 } },
  });
  const c2 = calc2.json();
  assert.equal(c2.buildupFactor, 1 + 0.3 * 4);
  assert.equal(c2.transmittedFluenceRate, 9000 * c2.broadTransmission);
  // 同一方案，透射率与入射注量率无关，两次一致。
  assert.equal(c2.narrowTransmission, c1.narrowTransmission);
});

test('未命名方案自动生成名字，且可取回', async () => {
  const reg = await app.inject({
    method: 'POST',
    url: '/schemes',
    payload: { layers: [{ mu: 1, x: 1 }] },
  });
  assert.equal(reg.statusCode, 201);
  const name = reg.json().name;
  const got = await app.inject({ method: 'GET', url: `/schemes/${encodeURIComponent(name)}` });
  assert.equal(got.statusCode, 200);
  assert.deepEqual(got.json().layers, [{ material: 'layer-1', mu: 1, x: 1 }]);
});

test('内置示范方案可直接核对：demo-pb-unit-hvl 严格 0.5', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/schemes/demo-pb-unit-hvl/calculate',
    payload: { fluenceRate: 1000 },
  });
  assert.equal(res.statusCode, 200);
  const b = res.json();
  assert.equal(b.narrowTransmission, 0.5);
  assert.equal(b.transmittedFluenceRate, 500);
});

test('方案不存在 → 404 结构化错误', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/schemes/missing/calculate',
    payload: {},
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().code, 'SCHEME_NOT_FOUND');
  assert.deepEqual(res.json().details, { name: 'missing' });
});

test('重复方案名 → 409', async () => {
  await app.inject({
    method: 'POST',
    url: '/schemes',
    payload: { name: 'uniq', layers: [{ mu: 1, x: 1 }] },
  });
  const res = await app.inject({
    method: 'POST',
    url: '/schemes',
    payload: { name: 'uniq', layers: [{ mu: 2, x: 2 }] },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, 'SCHEME_ALREADY_EXISTS');
});

test('非法参数 → 400，逐字段结构化说明', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/calculate',
    payload: { mu: -1, x: -2, fluenceRate: -3, buildup: { mode: 'direct', value: 0.2 } },
  });
  assert.equal(res.statusCode, 400);
  const b = res.json();
  assert.equal(b.code, 'VALIDATION_ERROR');
  const fields = b.details.map((d) => d.field).sort();
  assert.deepEqual(fields, ['buildup.value', 'fluenceRate', 'layers[0].mu', 'layers[0].x']);
});

test('非法 JSON body → 400 BAD_REQUEST', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/calculate',
    headers: { 'content-type': 'application/json' },
    payload: '{ not json',
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'BAD_REQUEST');
});

test('非物理结果（B·T>1）→ 422，而不是返回 >1 的透射率', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/calculate',
    payload: { mu: 0.001, x: 1, buildup: { mode: 'direct', value: 2 } },
  });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().code, 'UNPHYSICAL_RESULT');
  assert.ok(res.json().details.transmission > 1);
});

test('并发 HTTP：交错登记/取用/核算，结果不串方案', async () => {
  const N = 25;
  const tasks = [];
  for (let i = 0; i < N; i++) {
    tasks.push(
      app.inject({
        method: 'POST',
        url: '/schemes',
        payload: { name: `race-${i}`, layers: [{ material: `m${i}`, mu: 0.2 * (i + 1), x: i + 1 }] },
      }),
    );
  }
  const regs = await Promise.all(tasks);
  for (const r of regs) assert.equal(r.statusCode, 201);

  const calcs = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      app.inject({
        method: 'POST',
        url: `/schemes/race-${i}/calculate`,
        payload: { fluenceRate: 10 * i + 1, buildup: { mode: 'linear', coefficient: 0.1 } },
      }),
    ),
  );
  for (let i = 0; i < N; i++) {
    const b = calcs[i].json();
    const od = 0.2 * (i + 1) * (i + 1);
    assert.equal(b.totalOpticalDepth, od, `方案 race-${i} 光学厚度被串`);
    assert.equal(b.layers[0].material, `m${i}`);
    assert.equal(b.narrowTransmission, Math.exp(-od));
    assert.equal(b.buildupFactor, 1 + 0.1 * od);
    assert.equal(b.incidentFluenceRate, 10 * i + 1);
  }
});

test('多层堆叠方案：统一指数，且与逐层相乘可分辨', async () => {
  const reg = await app.inject({
    method: 'POST',
    url: '/schemes',
    payload: {
      name: 'multi-exact',
      layers: [
        { material: 'Pb', mu: 0.5, x: 0.5 },
        { material: 'conc', mu: 1, x: 2 },
      ],
    },
  });
  assert.equal(reg.statusCode, 201);
  const res = await app.inject({
    method: 'POST',
    url: '/schemes/multi-exact/calculate',
    payload: {},
  });
  const b = res.json();
  assert.equal(b.narrowTransmission, Math.exp(-2.25));
  assert.notEqual(b.narrowTransmission, Math.exp(-0.25) * Math.exp(-2));
});

// ---------- 反求厚度接口 ----------

test('POST /reverse：一次性反解，厚度代回严格达标且削薄即越限', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/reverse',
    payload: {
      layers: [{ material: 'Pb', mu: 1, x: 0, adjustable: true }],
      target: { metric: 'broadTransmission', limit: 0.1 },
      buildup: { mode: 'direct', value: 1 },
    },
  });
  assert.equal(res.statusCode, 200);
  const b = res.json();
  assert.ok(Math.abs(b.layers[0].x - Math.LN10) < 1e-9);
  // 正向重算严格 <= 限值（不是靠容差放过 1 ULP）。
  assert.ok(b.forward.broadTransmission <= 0.1);
  assert.equal(b.targetMet, true);
  assert.equal(b.reachable, true);
  assert.ok(b.addedOpticalDepth > 0);
  // 削薄一丁点 → 越过限值。
  const shaved = b.layers.map((l) => ({ material: l.material, mu: l.mu, x: l.x }));
  shaved[0].x -= 1e-9;
  const check = await app.inject({
    method: 'POST',
    url: '/calculate',
    payload: { layer: shaved[0], buildup: { mode: 'direct', value: 1 } },
  });
  assert.ok(check.json().broadTransmission > 0.1);
});

test('POST /reverse：线性 k>1 驼峰场景解在下降支，round-trip 达标', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/reverse',
    payload: {
      layers: [{ mu: 1, x: 0, adjustable: true }],
      target: { metric: 'broadTransmission', limit: 0.1 },
      buildup: { mode: 'linear', coefficient: 3 },
    },
  });
  assert.equal(res.statusCode, 200);
  const b = res.json();
  assert.ok(b.totalOpticalDepth > 2 / 3, '必须越过驼峰峰值点');
  assert.ok(b.forward.broadTransmission <= 0.1);
  assert.equal(b.forward.buildupBasis.mode, 'linear');
});

test('POST /reverse：多层固定+可调，固定层不动、增量按权重', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/reverse',
    payload: {
      layers: [
        { material: 'Pb', mu: 2, x: 0.5 },
        { material: 'conc', mu: 0.5, x: 0, adjustable: true, weight: 1 },
        { material: 'fe', mu: 1, x: 0, adjustable: true, weight: 3 },
      ],
      target: { metric: 'broadTransmission', limit: 0.01 },
    },
  });
  assert.equal(res.statusCode, 200);
  const b = res.json();
  assert.equal(b.layers[0].x, 0.5);
  assert.equal(b.layers[0].addedThickness, 0);
  const odConc = b.layers[1].mu * b.layers[1].x;
  const odFe = b.layers[2].mu * b.layers[2].x;
  assert.ok(Math.abs(odFe / odConc - 3) < 1e-9);
  assert.ok(b.forward.broadTransmission <= 0.01);
});

test('POST /reverse：相对剂量率目标 + 入射注量率，回算出射注量率', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/reverse',
    payload: {
      layer: { mu: 0.5, x: 0, adjustable: true },
      target: { metric: 'relativeDoseRate', limit: 0.25 },
      fluenceRate: 800,
    },
  });
  assert.equal(res.statusCode, 200);
  const b = res.json();
  assert.ok(b.forward.relativeDoseRate <= 0.25);
  assert.ok(Math.abs(b.forward.transmittedFluenceRate - 200) < 1e-9);
});

test('POST /reverse：顶到上限仍不达标 → 422 TARGET_UNREACHABLE，不返回越限厚度', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/reverse',
    payload: {
      layers: [{ mu: 1, x: 0, adjustable: true, maxX: 1 }],
      target: { metric: 'broadTransmission', limit: 0.01 },
    },
  });
  assert.equal(res.statusCode, 422);
  const b = res.json();
  assert.equal(b.code, 'TARGET_UNREACHABLE');
  assert.ok(Number.isFinite(b.details.bestAchievable));
  assert.ok(b.details.bestAchievable > 0.01);
  assert.ok(Number.isFinite(b.details.maxedLayers[0].x));
});

test('POST /reverse：非法目标/无可调层 → 400 逐字段结构化错误', async () => {
  const r1 = await app.inject({
    method: 'POST',
    url: '/reverse',
    payload: { layers: [{ mu: 1, x: 0, adjustable: true }], target: { metric: 'broadTransmission', limit: 0 } },
  });
  assert.equal(r1.statusCode, 400);
  assert.equal(r1.json().code, 'VALIDATION_ERROR');
  assert.ok(r1.json().details.some((d) => d.field === 'target.limit'));

  const r2 = await app.inject({
    method: 'POST',
    url: '/reverse',
    payload: { layers: [{ mu: 1, x: 0 }], target: { metric: 'relativeDoseRate', limit: -0.5 } },
  });
  assert.equal(r2.statusCode, 400);
  const fields = r2.json().details.map((d) => d.field).sort();
  assert.deepEqual(fields, ['layers', 'target.limit']);
});

test('POST /schemes/:name/reverse：沿用已登记层结构，只在指定层上加增量', async () => {
  await app.inject({
    method: 'POST',
    url: '/schemes',
    payload: {
      name: 'rev-wall',
      layers: [
        { material: 'Pb', mu: 2, x: 1 },      // 固定
        { material: 'concrete', mu: 0.5, x: 4 }, // 允许加厚
      ],
    },
  });
  // 现状总 od = 2+2 = 4，T=e^-4≈0.0183；压到 0.001 需 od≈6.9078。
  const res = await app.inject({
    method: 'POST',
    url: '/schemes/rev-wall/reverse',
    payload: { target: { metric: 'broadTransmission', limit: 0.001 }, adjustable: ['concrete'] },
  });
  assert.equal(res.statusCode, 200);
  const b = res.json();
  assert.equal(b.scheme, 'rev-wall');
  assert.equal(b.layers[0].x, 1); // Pb 固定
  assert.ok(b.layers[1].x > 4); // concrete 加厚
  assert.ok(Math.abs(b.layers[0].mu * b.layers[0].x - 2) < 1e-12);
  assert.ok(b.forward.broadTransmission <= 0.001);
  // 登记的方案本身不被改写。
  const got = await app.inject({ method: 'GET', url: '/schemes/rev-wall' });
  assert.deepEqual(got.json().layers[1], { material: 'concrete', mu: 0.5, x: 4 });
});

test('POST /schemes/:name/reverse：下标/对象标记与 maxX 上限生效', async () => {
  await app.inject({
    method: 'POST',
    url: '/schemes',
    payload: { name: 'rev-cap', layers: [{ material: 'Pb', mu: 1, x: 0.2 }] },
  });
  // 只允许加到 x=1，最好成绩 e^-1≈0.368，压不到 0.01 → 422。
  const res = await app.inject({
    method: 'POST',
    url: '/schemes/rev-cap/reverse',
    payload: {
      target: { metric: 'broadTransmission', limit: 0.01 },
      adjustable: [{ index: 0, maxX: 1 }],
    },
  });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().code, 'TARGET_UNREACHABLE');
});

test('POST /schemes/:name/reverse：方案不存在 → 404；未标可调层 → 400', async () => {
  const r1 = await app.inject({
    method: 'POST',
    url: '/schemes/nope/reverse',
    payload: { target: { metric: 'broadTransmission', limit: 0.1 } },
  });
  assert.equal(r1.statusCode, 404);
  assert.equal(r1.json().code, 'SCHEME_NOT_FOUND');

  const r2 = await app.inject({
    method: 'POST',
    url: '/schemes/demo-pb-unit-hvl/reverse',
    payload: { target: { metric: 'broadTransmission', limit: 0.1 } },
  });
  assert.equal(r2.statusCode, 400);
  assert.ok(r2.json().details.some((d) => d.field === 'layers'));
});
