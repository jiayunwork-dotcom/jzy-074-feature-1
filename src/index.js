/**
 * 服务入口。配置：
 *  - PORT       监听端口（默认 3000）
 *  - HOST       监听地址（默认 0.0.0.0，容器内可达）
 *  - DB_PATH    SQLite 落盘路径（默认 /data/shield.sqlite）
 */
import { buildApp } from './app.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const DB_PATH = process.env.DB_PATH ?? '/data/shield.sqlite';

const app = await buildApp({ dbPath: DB_PATH, seed: true, logger: true });

const shutdown = async (signal) => {
  app.log.info({ signal }, '正在关闭服务');
  try {
    await app.close(); // 会触发 better-sqlite3 连接释放
  } finally {
    process.exit(0);
  }
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info({ url: `http://${HOST}:${PORT}` }, '辐射屏蔽核算服务已启动');
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
