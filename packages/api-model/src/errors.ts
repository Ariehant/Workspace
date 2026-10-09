/** Notion's error codes, with the HTTP status each goes with. */
export const ERROR_STATUS = {
  invalid_json: 400,
  invalid_request_url: 400,
  invalid_request: 400,
  validation_error: 400,
  missing_version: 400,
  unauthorized: 401,
  restricted_resource: 403,
  object_not_found: 404,
  conflict_error: 409,
  rate_limited: 429,
  internal_server_error: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/** An API error, sent as `{object: "error", status, code, message}`. */
export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = ERROR_STATUS[code];
  }

  toJSON() {
    return { object: 'error', status: this.status, code: this.code, message: this.message };
  }
}

export const invalid = (message: string) => new ApiError('validation_error', message);

export const notFound = (id: string) =>
  new ApiError(
    'object_not_found',
    `Could not find object with ID: ${id}. Make sure the relevant pages and databases are shared with your integration.`,
  );
