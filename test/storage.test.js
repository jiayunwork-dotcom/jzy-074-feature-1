/**
 * 方案存取与并发隔离测试。
 * 每个测试用独立的 :memory: SQLite，互不影响。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, registerScheme, getScheme, listSchemes, seedDemoSchemes } from '../src/storage/schemes.js';
import { ConflictError, NotFoundError } from '../src/physics/errors.js';
import { DEMO_SCHEMES } from '../src/storage/demos.js';
import { evaluateShielding } from '../src/physics/multilayer.js';

function memDb(seed = false) {
  const db = openDatabase(':memory:');
  if (seed) seedDemoSchemes(db);
  return db;
}

test('登记后可凭名字稳定取用，层参数原样返回', () => {
  const db = memDb();
  const layers = [
    { material: 'Pb', mu: 2.1, x: 1.5 },
    { material: 'concrete', mu: 0.22, x: 20 },
  ];
  const { name } = registerScheme(db, { name: 'wall-1', layers });
  const got = getScheme(db, name);
  assert.equal(got.name, 'wall-1');
  assert.deepEqual(got.layers, layers);
});

test('未提供名字时自动生成；重复登记同名方案冲突(409)', () => {
  const db = memDb();
  const a = registerScheme(db, { layers: [{ mu: 1, x: 1 }] });
  assert.match(a.name, /^scheme-/);
  const b = registerScheme(db, { layers: [{ mu: 1, x: 1 }] });
  assert.notEqual(a.name, b.name);
  // 同名首次登记成功，第二次冲突（409）。
  registerScheme(db, { name: 'dup', layers: [{ mu: 1, x: 1 }] });
  assert.throws(
    () => registerScheme(db, { name: 'dup', layers: [{ mu: 2, x: 2 }] }),
    (e) => e instanceof ConflictError && e.statusCode === 409,
  );
  // 冲突不得覆盖原方案。
  assert.deepEqual(getScheme(db, 'dup').layers, [{ mu: 1, x: 1 }]);
});

test('取用不存在的方案名返回 404', () => {
  const db = memDb();
  assert.throws(() => getScheme(db, 'nope'), (e) => e instanceof NotFoundError && e.statusCode === 404);
});

test('内置示范方案全部登记，且一个 HVL 铅层给出 0.5 附近的窄束透射率', () => {
  const db = memDb(true);
  const names = listSchemes(db).map((s) => s.name);
  for (const d of DEMO_SCHEMES) assert.ok(names.includes(d.name));

  const unit = getScheme(db, 'demo-pb-unit-hvl');
  const r = evaluateShielding(unit.layers);
  assert.equal(r.narrowTransmission, 0.5); // μ=ln2, x=1，位精确

  const tvl = getScheme(db, 'demo-pb-unit-tvl');
  const r2 = evaluateShielding(tvl.layers);
  assert.ok(Math.abs(r2.narrowTransmission - 0.1) <= Number.EPSILON);

  for (const refName of ['demo-co60-pb-hvl', 'demo-cs137-pb-hvl', 'demo-ir192-pb-hvl']) {
    const ref = getScheme(db, refName);
    const rr = evaluateShielding(ref.layers);
    assert.ok(Math.abs(rr.narrowTransmission - 0.5) < 1e-12, `${refName} 应在 0.5 附近`);
  }
});

test('种子幂等：重复播种不报错、不覆盖既有方案', () => {
  const db = memDb();
  registerScheme(db, { name: 'demo-co60-pb-hvl', layers: [{ material: 'custom', mu: 9, x: 9 }] });
  assert.doesNotThrow(() => seedDemoSchemes(db));
  assert.deepEqual(getScheme(db, 'demo-co60-pb-hvl').layers, [{ material: 'custom', mu: 9, x: 9 }]);
});

test('同一方案换不同入射注量率反复算：透射率不变，出射注量率按比例变化', () => {
  const db = memDb();
  registerScheme(db, { name: 's', layers: [{ material: 'Pb', mu: 1, x: Math.LN2 }] });
  const scheme = getScheme(db, 's');
  const r1 = evaluateShielding(scheme.layers, { fluenceRate: 100 });
  const r2 = evaluateShielding(scheme.layers, { fluenceRate: 8000 });
  assert.equal(r1.broadTransmission, 0.5);
  assert.equal(r2.broadTransmission, 0.5);
  assert.equal(r1.transmittedFluenceRate, 50);
  assert.equal(r2.transmittedFluenceRate, 4000);
});

test('并发：同时登记多个方案互不串改，每个方案算回自己的厚度', async () => {
  const db = memDb();
  const N = 30;
  const specs = Array.from({ length: N }, (_, i) => ({
    name: `concurrent-${i}`,
    layers: [{ material: `M${i}`, mu: 0.1 * (i + 1), x: i + 1 }],
  }));

  // 并发登记（事件循环层面全部在同一 tick 发起）。
  await Promise.all(specs.map((s) => Promise.resolve().then(() => registerScheme(db, s))));

  // 并发读取 + 核算：每个名字必须只拿到自己的 μ、x。
  const results = await Promise.all(
    specs.map((s, i) =>
      Promise.resolve().then(() => {
        const got = getScheme(db, s.name);
        const r = evaluateShielding(got.layers, { fluenceRate: 1000 });
        return { i, got, r };
      }),
    ),
  );
  for (const { i, got, r } of results) {
    const s = specs[i];
    assert.equal(got.layers[0].mu, s.layers[0].mu, `方案 ${i} 的 μ 被串改`);
    assert.equal(got.layers[0].x, s.layers[0].x, `方案 ${i} 的厚度被串改`);
    assert.equal(r.layers[0].material, `M${i}`);
    assert.equal(
      r.narrowTransmission,
      Math.exp(-0.1 * (i + 1) * (i + 1)),
    );
    assert.equal(r.transmittedFluenceRate, 1000 * r.broadTransmission);
  }
  assert.equal(listSchemes(db).length, N);
});

test('并发：登记与核算交错进行，已存在方案的结果不被新登记影响', async () => {
  const db = memDb();
  registerScheme(db, { name: 'fixed', layers: [{ mu: Math.LN10, x: 1 }] });

  const tasks = [];
  for (let i = 0; i < 20; i++) {
    tasks.push(
      Promise.resolve().then(() =>
        registerScheme(db, { name: `other-${i}`, layers: [{ mu: i + 1, x: i + 1 }] }),
      ),
    );
    tasks.push(
      Promise.resolve().then(() => {
        const r = evaluateShielding(getScheme(db, 'fixed').layers);
        assert.ok(Math.abs(r.narrowTransmission - 0.1) <= Number.EPSILON);
      }),
    );
  }
  await Promise.all(tasks);
});
