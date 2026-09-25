/**
 * 屏蔽方案的登记与存取，独立成模块。
 *
 * 持久化使用容器内的轻量 SQLite（better-sqlite3，同步 API），
 * 不需要外部数据库。Node 20 事件循环为单线程，better-sqlite3
 * 的语句执行又是同步的，一条请求的"读取方案→计算"不会被另一条
 * 请求的写入穿插，因此不同方案的厚度不会串到彼此的结果里。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { ConflictError, NotFoundError } from '../physics/errors.js';
import { DEMO_SCHEMES } from './demos.js';

/**
 * 打开（必要时创建）数据库并建表。
 * @param {string} dbPath SQLite 文件路径；':memory:' 为内存库（测试用）。
 * @returns {import('better-sqlite3').Database}
 */
export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schemes (
      name        TEXT PRIMARY KEY,
      layers_json TEXT NOT NULL,
      description TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

/**
 * @typedef {{ mu: number, x: number, material?: string }} LayerInput
 */

/**
 * 登记一个具名方案。
 * @param {import('better-sqlite3').Database} db
 * @param {{ name?: string, layers: LayerInput[], description?: string }} input
 * @returns {{ name: string, layers: LayerInput[], description?: string }}
 */
export function registerScheme(db, input) {
  const name = (input.name?.trim() || `scheme-${randomUUID()}`).trim();
  const layers = input.layers.map((l) => ({
    material: l.material,
    mu: l.mu,
    x: l.x,
  }));
  const description = input.description ?? null;

  const inserted = db
    .prepare(
      `INSERT INTO schemes (name, layers_json, description)
       VALUES (@name, @layersJson, @description)
       ON CONFLICT(name) DO NOTHING`,
    )
    .run({ name, layersJson: JSON.stringify(layers), description });

  if (inserted.changes === 0) {
    throw new ConflictError(`方案名 '${name}' 已存在`, { name });
  }
  return { name, layers, description: input.description };
}

/**
 * 取出方案；不存在抛 404。
 * @param {import('better-sqlite3').Database} db
 * @param {string} name
 * @returns {{ name: string, layers: LayerInput[], description?: string }}
 */
export function getScheme(db, name) {
  const row = db.prepare('SELECT name, layers_json, description FROM schemes WHERE name = ?').get(name);
  if (!row) throw new NotFoundError(`方案 '${name}' 不存在`, { name });
  return { name: row.name, layers: JSON.parse(row.layers_json), description: row.description ?? undefined };
}

/** 列出全部方案名（含内置示范方案）。 */
export function listSchemes(db) {
  return db
    .prepare('SELECT name, description, created_at FROM schemes ORDER BY name')
    .all();
}

/** 幂等写入内置示范方案：已存在同名方案时保留既有版本，不覆盖、不报错。 */
export function seedDemoSchemes(db) {
  for (const demo of DEMO_SCHEMES) {
    try {
      registerScheme(db, demo);
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
    }
  }
}
