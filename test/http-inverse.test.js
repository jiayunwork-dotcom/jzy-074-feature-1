/**
 * 反解接口 HTTP 端到端测试：
 *  - POST /inverse（不登记，材料/目标直接传入）
 *  - POST /schemes/:name/inverse（沿用具名方案层结构，只在可调层求增量）
 *  - round-trip 自洽、最小性、不可达 422、非法目标 400、方案不存在 404。
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

test('POST /inverse 单层 direct：返回最小厚度，代回正向核算压在限值内', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/inverse',
    payload: {
      layers: [{ material: 'Pb', mu: 2, x: 0, adjustable: true }],
      target: { metric: 'broadTransmission', limit: 0.1 },
      buildup: { mode: 'direct', value: 1 },
    },
  });
  assert.equal(res.statusCode, 200);
  const b = res.json();
  assert.equal(b.feasible, true);
  const expectedX = Math.LN10 / 2;
  assert.ok(Math.abs(b.layers[0].x - expectedX) <= 1e-9 * expectedX);
  assert.equal(b.layers[0].adjustable, true);
  assert.equal(b.layers[0].initialX, 0);
  assert.ok(b.layers[0].addedX > 0);
  // forward 字段即正向核算结果，与限值判定一致。
  assert.ok(b.forward.broadTransmission <= 0.1 + Number.EPSILON * 2);
  assert.equal(b.achievedMetric, b.forward.broadTransmission);
  assert.equal(b.target.metric, 'broadTransmission');
});

test('POST /inverse 支持 layer 包裹与缺省 buildup/fluenceRate', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/inverse',
    payload: { layer: { mu: 1, x: 0, adjustable: true }, target: { limit: 0.5 } },
  });
  assert.equal(res.statusCode, 200);
  const b = res.json();
  assert.ok(Math.abs(b.layers[0].x - Math.LN2) <= 1e-9);
  assert.ok(b.forward.broadTransmission <= 0.5 + Number.EPSILON * 2);
});

test('POST /inverse linear 非单调（k=2）：取到下降支上的可行厚度', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/inverse',
    payload: {
      layers: [{ material: 'Pb', mu: 1, x: 0, adjustable: true }],
      target: { metric: 'broadTransmission', limit: 0.5 },
      buildup: { mode: 'linear', coefficient: 2 },
    },
  });
  assert.equal(res.statusCode, 200);
  const b = res.json();
  assert.ok(b.totalOpticalDepth > 1, '必须越过峰值 y=k-1=1');
  assert.ok(b.forward.broadTransmission <= 0.5 + 2 * Number.EPSILON);
});

test('POST /inverse 多层部分固定：固定层不动，增量只在可调层', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/inverse',
    payload: {
      layers: [
        { material: 'concrete', mu: 0.5, x: 4 },
        { material: 'Pb', mu: 2, x: 0, adjustable: true },
      ],
      target: { metric: 'broadTransmission', limit: 0.01 },
      buildup: { mode: 'direct', value: 1 },
      fluenceRate: 1000,
    },
  });
  assert.equal(res.statusCode, 200);
  const b = res.json();
  assert.equal(b.layers[0].x, 4);
  assert.equal(b.layers[0].addedX, 0);
  assert.equal(b.layers[0].adjustable, false);
  const expectedPb = (2 * Math.LN10 - 2) / 2;
  assert.ok(Math.abs(b.layers[1].x - expectedPb) <= 1e-9);
  assert.ok(b.forward.broadTransmission <= 0.01 + 1e-12);
  assert.equal(b.forward.transmittedFluenceRate, 1000 * b.forward.broadTransmission);
});

test('POST /inverse 带 maxX：高 μ 层填满后溢出到次选层', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/inverse',
    payload: {
      layers: [
        { material: 'Pb', mu: 2, x: 0, adjustable: true, maxX: 0.1 },
        { material: 'conc', mu: 0.5, x: 0, adjustable: true },
      ],
      target: { metric: 'broadTransmission', limit: 0.5 },
      buildup: { mode: 'direct', value: 1 },
    },
  });
  assert.equal(res.statusCode, 200);
  const b = res.json();
  assert.equal(b.layers[0].x, 0.1);
  assert.ok(Math.abs(b.layers[1].x - (Math.LN2 - 0.2) / 0.5) <= 1e-9);
  assert.ok(b.forward.broadTransmission <= 0.5 + 2 * Number.EPSILON);
});

test('可调层全部顶到上限仍不达标 → 422 TARGET_UNREACHABLE（不是越限厚度）', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/inverse',
    payload: {
      layers: [
        { material: 'Pb', mu: 2, x: 0, adjustable: true, maxX: 0.1 },
        { material: 'conc', mu: 0.5, x: 0, adjustable: true, maxX: 0.9 },
      ],
      target: { metric: 'broadTransmission', limit: 0.5 },
      buildup: { mode: 'direct', value: 1 },
    },
  });
  assert.equal(res.statusCode, 422);
  const b = res.json();
  assert.equal(b.code, 'TARGET_UNREACHABLE');
  assert.ok(b.details.achieved > 0.5);
  assert.equal(b.details.maxOpticalDepth, 0.65);
});

test('非单调下封顶配置 T>1：也是 422 TARGET_UNREACHABLE', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/inverse',
    payload: {
      layers: [{ mu: 1, x: 0, adjustable: true, maxX: 0.5 }],
      target: { metric: 'broadTransmission', limit: 0.5 },
      buildup: { mode: 'linear', coefficient: 2 },
    },
  });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().code, 'TARGET_UNREACHABLE');
});

test('非法目标限值 → 400，逐字段结构化说明', async () => {
  const cases = [
    { target: { metric: 'broadTransmission', limit: 0 }, field: 'target.limit' },
    { target: { metric: 'broadTransmission', limit: -1 }, field: 'target.limit' },
    { target: { metric: 'broadTransmission', limit: 1.5 }, field: 'target.limit' },
    { target: { metric: 'relativeDoseRate', limit: -2 }, field: 'target.limit' },
    { target: { metric: 'wat', limit: 0.5 }, field: 'target.metric' },
  ];
  for (const payload of cases) {
    const res = await app.inject({
      method: 'POST',
      url: '/inverse',
      payload: { layers: [{ mu: 1, x: 0, adjustable: true }], ...payload },
    });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    const b = res.json();
    assert.equal(b.code, 'VALIDATION_ERROR');
    assert.ok(b.details.some((d) => d.field === payload.field),
      `应报告 ${payload.field}，实际 ${b.details.map((d) => d.field)}`);
  }
});

test('没有可调层 → 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/inverse',
    payload: { layers: [{ mu: 1, x: 2 }], target: { metric: 'broadTransmission', limit: 0.5 } },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'VALIDATION_ERROR');
});

test('maxX 小于当前厚度 → 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/inverse',
    payload: {
      layers: [{ mu: 1, x: 3, adjustable: true, maxX: 2 }],
      target: { metric: 'broadTransmission', limit: 0.5 },
    },
  });
  assert.equal(res.statusCode, 400);
  assert.ok(res.json().details.some((d) => d.field === 'layers[0].maxX'));
});

test('POST /schemes/:name/inverse：沿用已登记层结构，按序号指定可调层', async () => {
  await app.inject({
    method: 'POST',
    url: '/schemes',
    payload: {
      name: 'wall-inv',
      layers: [
        { material: 'concrete', mu: 0.5, x: 4 },
        { material: 'Pb', mu: 2, x: 0 },
      ],
    },
  });
  const res = await app.inject({
    method: 'POST',
    url: '/schemes/wall-inv/inverse',
    payload: {
      target: { metric: 'broadTransmission', limit: 0.01 },
      adjustable: [1],
      buildup: { mode: 'direct', value: 1 },
    },
  });
  assert.equal(res.statusCode, 200);
  const b = res.json();
  assert.equal(b.scheme, 'wall-inv');
  assert.equal(b.layers[0].x, 4);
  assert.equal(b.layers[0].addedX, 0);
  const expectedPb = (2 * Math.LN10 - 2) / 2;
  assert.ok(Math.abs(b.layers[1].x - expectedPb) <= 1e-9);
  assert.ok(b.forward.broadTransmission <= 0.01 + 1e-12);
});

test('具名方案反解：对象写法可给 maxX；封顶不足时 422', async () => {
  // demo-pb-unit-hvl：单层 μ=ln2，x=1。允许加厚但最多再加 0.1（maxX=1.1）
  // → 总 y≤ln2·1.1≈0.762，T=e^-0.762≈0.467 > 0.1，不可达。
  const res = await app.inject({
    method: 'POST',
    url: '/schemes/demo-pb-unit-hvl/inverse',
    payload: {
      target: { metric: 'broadTransmission', limit: 0.1 },
      adjustable: [{ index: 0, maxX: 1.1 }],
      buildup: { mode: 'direct', value: 1 },
    },
  });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().code, 'TARGET_UNREACHABLE');

  // 不封顶即可达。
  const ok = await app.inject({
    method: 'POST',
    url: '/schemes/demo-pb-unit-hvl/inverse',
    payload: { target: { metric: 'broadTransmission', limit: 0.1 }, adjustable: [0] },
  });
  assert.equal(ok.statusCode, 200);
  const body = ok.json();
  assert.ok(body.forward.broadTransmission <= 0.1 + 2 * Number.EPSILON);
  // 从已登记的 x=1 起算，增量为正而不是从零重算。
  assert.equal(body.layers[0].initialX, 1);
  assert.ok(body.layers[0].x > 1);
});

test('具名方案反解：方案不存在 → 404', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/schemes/nope/inverse',
    payload: { target: { metric: 'broadTransmission', limit: 0.1 }, adjustable: [0] },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().code, 'SCHEME_NOT_FOUND');
});

test('具名方案反解：adjustable 为空/序号越界/重复 → 400', async () => {
  const empty = await app.inject({
    method: 'POST',
    url: '/schemes/demo-pb-unit-hvl/inverse',
    payload: { target: { metric: 'broadTransmission', limit: 0.1 }, adjustable: [] },
  });
  assert.equal(empty.statusCode, 400);

  const oob = await app.inject({
    method: 'POST',
    url: '/schemes/demo-pb-unit-hvl/inverse',
    payload: { target: { metric: 'broadTransmission', limit: 0.1 }, adjustable: [5] },
  });
  assert.equal(oob.statusCode, 400);
  assert.equal(oob.json().code, 'VALIDATION_ERROR');

  const dup = await app.inject({
    method: 'POST',
    url: '/schemes/demo-pb-unit-hvl/inverse',
    payload: { target: { metric: 'broadTransmission', limit: 0.1 }, adjustable: [0, 0] },
  });
  assert.equal(dup.statusCode, 400);
});
