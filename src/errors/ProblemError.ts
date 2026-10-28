import httpStatus from 'http-status';

// Stable error codes clients branch on (docs/api/errors.md).
export type TProblemCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden_scope'
  | 'not_found'
  | 'invalid_state'
  | 'has_references'
  | 'file_too_large'
  | 'unsupported_type'
  | 'invalid_content'
  | 'idempotency_key_reused'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'internal'
  | 'unavailable';

const statusByCode: Record<TProblemCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden_scope: 403,
  not_found: 404,
  invalid_state: 409,
  has_references: 409,
  file_too_large: 413,
  unsupported_type: 415,
  invalid_content: 422,
  idempotency_key_reused: 422,
  rate_limited: 429,
  quota_exceeded: 507,
  internal: 500,
  unavailable: 503,
};

class ProblemError extends Error {
  code: TProblemCode;
  status: number;
  headers: Record<string, string>;

  constructor(
    code: TProblemCode,
    detail: string,
    headers: Record<string, string> = {}
  ) {
    super(detail);
    this.code = code;
    this.status = statusByCode[code];
    this.headers = headers;
  }

  get title(): string {
    return (httpStatus as unknown as Record<number, string>)[this.status];
  }
}

export default ProblemError;
