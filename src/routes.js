/**
 * HTTP 路由层。只负责解析/校验输入、调用存储模块与物理核心模块、
 * 组织响应。衰减公式一律来自 src/physics，路由层不自行推导。
 */
import {
  validateSingleCalcBody,
  validateSchemeCalcBody,
  validateRegisterBody,
  validateNameParam,
  validateReverseBody,
  validateSchemeReverseBody,
} from './physics/validation.js';
import { evaluateShielding } from './physics/multilayer.js';
import { reverseSolve } from './physics/reverse.js';
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
   * 4) 凭方案名按目标反求最小厚度（只在允许加厚的层上加增量）
   * POST /schemes/:name/reverse
   * body: { target: { metric, limit }, adjustable?: [...], fluenceRate?, buildup? }
   * 沿用已登记的层结构与各层当前厚度；adjustable 标明可加厚的层（下标/材料名/对象）。
   */
  app.post('/schemes/:name/reverse', async (request) => {
    const name = validateNameParam(request.params.name);
    const scheme = getScheme(db, name); // 不存在在此抛 404
    const { layers, target, fluenceRate, buildup } = validateSchemeReverseBody(request.body, scheme.layers);
    const result = reverseSolve(layers, { target, fluenceRate, buildup });
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

  /**
   * 5) 不登记的一次性反解：给目标限值与材料，求达标所需的最小厚度
   * POST /reverse
   * body: { layers: [{ mu, x, adjustable?, maxX?, weight?, material? }],
   *         target: { metric: 'broadTransmission'|'relativeDoseRate', limit },
   *         fluenceRate?, buildup? }
   * 单层也可平铺 { mu, x, adjustable, ... } 或用 layer 包裹。
   * 返回达标厚度配置 + 该配置代回正向核算的完整结果。
   * 顶到各可调层上限仍不达标 → 422 TARGET_UNREACHABLE。
   */
  app.post('/reverse', async (request) => {
    const { layers, target, fluenceRate, buildup } = validateReverseBody(request.body);
    return reverseSolve(layers, { target, fluenceRate, buildup });
  });
}
