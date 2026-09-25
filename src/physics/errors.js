/**
 * 结构化错误类型。所有业务错误携带 HTTP 状态码、机器可读 code 与 details。
 */
export class ShieldError extends Error {
  constructor(message, { statusCode, code, details = undefined } = {}) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/** 入参不合法（400），details 为逐字段错误列表。 */
export class ValidationError extends ShieldError {
  constructor(details) {
    super('参数校验失败', { statusCode: 400, code: 'VALIDATION_ERROR', details });
  }
}

/** 方案名不存在（404）。 */
export class NotFoundError extends ShieldError {
  constructor(message, details) {
    super(message, { statusCode: 404, code: 'SCHEME_NOT_FOUND', details });
  }
}

/** 方案名已存在（409）。 */
export class ConflictError extends ShieldError {
  constructor(message, details) {
    super(message, { statusCode: 409, code: 'SCHEME_ALREADY_EXISTS', details });
  }
}

/**
 * 输入通过了校验，但模型给出了非物理结果（422），
 * 例如透射率 < 0 或 > 1。不允许把这种结果当正常响应返回。
 */
export class UnphysicalResultError extends ShieldError {
  constructor(message, details) {
    super(message, { statusCode: 422, code: 'UNPHYSICAL_RESULT', details });
  }
}
