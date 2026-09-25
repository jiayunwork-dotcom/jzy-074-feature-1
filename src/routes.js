/**
 * HTTP 路由层。只负责解析/校验输入、调用存储模块与物理核心模块、
 * 组织响应。衰减公式一律来自 src/physics，路由层不自行推导。
 */
import { validateSingleCalcBody, validateSchemeCalcBody, validateRegisterBody, validateNameParam } from './physics/validation.js';
import { evaluateShielding } from './physics/multilayer.js';
import { registerScheme, getScheme, listSchemes } from './storage/schemes.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {import('fastify').FastifyInstance}
 */
export function registerRoutes(app, db) {
  app.get('/healthz', async () => ({ status: 'ok' }));

  /**
   * 1) 登记屏蔽方案
   * POST /schemes
   * body: { name?: string, layers: [{ material?, mu, x }] }
   * 返回方案名（未提供名称时自动生成）。
   */
  app.post('/schemes', async (request, reply) => {
    const { name, layers } = validateRegisterBody(request.body);
    const scheme = registerScheme(db, { name, layers });
    return reply.code(201).send({ name: scheme.name, layerCount: layers.length, layers: scheme.layers });
  });

  app.get('/schemes', async () => ({ schemes: listSchemes(db) }));

  app.get('/schemes/:name', async (request) => {
    const name = validateNameParam(request.params.name);
    return getScheme(db, name);
  });

  /**
   * 2) 凭方案名 + 入射注量率核算
   * POST /schemes/:name/calculate
   * body: { fluenceRate?, buildup?: { mode: 'direct', value } | { mode: 'linear', coefficient } }
   * 返回窄束/宽束透射率、HVL、TVL、总透射率、相对剂量率。
   * 同一方案可换不同入射注量率反复算，层结构只需登记一次。
   */
  app.post('/schemes/:name/calculate', async (request) => {
    const name = validateNameParam(request.params.name);
    const { fluenceRate, buildup } = validateSchemeCalcBody(request.body);
    const scheme = getScheme(db, name); // 不存在在此抛 404
    const result = evaluateShielding(scheme.layers, { fluenceRate, buildup });
    return { scheme: name, ...result };
  });

  /**
   * 3) 不登记的一次性单层核算
   * POST /calculate
   * body: { mu, x, material?, fluenceRate?, buildup? }
   *        或 { layer: { mu, x, material? }, fluenceRate?, buildup? }
   */
  app.post('/calculate', async (request) => {
    const { layer, fluenceRate, buildup } = validateSingleCalcBody(request.body);
    return evaluateShielding([layer], { fluenceRate, buildup });
  });
}
