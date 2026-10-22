export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message = '请求格式错误', details) =>
  new HttpError(400, 'BAD_REQUEST', message, details);
export const unauthenticated = (message = '请先登录') =>
  new HttpError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = '没有权限执行此操作', details) =>
  new HttpError(403, 'FORBIDDEN', message, details);
export const notFound = (message = '资源不存在') =>
  new HttpError(404, 'NOT_FOUND', message);
export const conflict = (message, code = 'CONFLICT', details) =>
  new HttpError(409, code, message, details);
export const invalid = (message, details) =>
  new HttpError(422, 'VALIDATION_ERROR', message, details);
export const tooLarge = (message = '请求体超过限制') =>
  new HttpError(413, 'PAYLOAD_TOO_LARGE', message);
