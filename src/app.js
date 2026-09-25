/**
 * Fastify 应用构建。物理模块与路由可在此被独立装配，
 * 测试通过注入 :memory: 数据库获得完全隔离的实例。
 */
import Fastify from 'fastify';
import { openDatabase, seedDemoSchemes } from './storage/schemes.js';
import { registerRoutes } from './routes.js';
import { ShieldError } from './physics/errors.js';

/**
 * @param {{ dbPath?: string, seed?: boolean, logger?: boolean }} [options]
 */
export async function buildApp(options = {}) {
  const dbPath = options.dbPath ?? process.env.DB_PATH ?? './data/shield.sqlite';
  const db = openDatabase(dbPath);
  if (options.seed ?? true) seedDemoSchemes(db);

  const app = Fastify({ logger: options.logger ?? false });
  app.decorate('db', db);

  registerRoutes(app, db);

  // 统一结构化错误响应。
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ShieldError) {
      return reply.code(error.statusCode).send({
        error: true,
        code: error.code,
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
      });
    }
    // Fastify 自身的 body 解析/序列化错误。
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({
        error: true,
        code: 'BAD_REQUEST',
        message: error.message,
      });
    }
    request.log.error(error);
    return reply.code(500).send({ error: true, code: 'INTERNAL_ERROR', message: '内部错误' });
  });

  await app.ready();
  return app;
}
