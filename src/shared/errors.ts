/**
 * Application error type with stable, machine-readable codes.
 * Every API error response is rendered from these.
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_JSON'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_A_MEMBER'
  | 'NOT_FOUND'
  | 'ALREADY_REGISTERED'
  | 'WORKSHOP_CANCELLED'
  | 'NOT_NEEDS_ATTENTION'
  | 'IDEMPOTENCY_PAYLOAD_MISMATCH'
  | 'MISSING_IDEMPOTENCY_KEY'
  | 'FAULTS_DISABLED'
  | 'MOCK_UNREACHABLE'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const appErrors = {
  validation: (message: string, details?: unknown) =>
    new AppError('VALIDATION_ERROR', message, 400, details),
  invalidJson: (message = 'Request body is not valid JSON.') =>
    new AppError('INVALID_JSON', message, 400),
  payloadTooLarge: (message = 'Request body is too large.') =>
    new AppError('PAYLOAD_TOO_LARGE', message, 413),
  unauthorized: (message = 'Missing or invalid bearer token.') =>
    new AppError('UNAUTHORIZED', message, 401),
  forbidden: (message = 'This identity may not perform that action.') =>
    new AppError('FORBIDDEN', message, 403),
  notAMember: (message = 'This identity cannot register; it has no member profile.') =>
    new AppError('NOT_A_MEMBER', message, 403),
  notFound: (message = 'Resource not found.') => new AppError('NOT_FOUND', message, 404),
  alreadyRegistered: (message = 'This member is already registered for the workshop.') =>
    new AppError('ALREADY_REGISTERED', message, 409),
  workshopCancelled: (message = 'This workshop has been cancelled.') =>
    new AppError('WORKSHOP_CANCELLED', message, 409),
  notNeedsAttention: (message = 'Only NEEDS_ATTENTION events can be requeued manually.') =>
    new AppError('NOT_NEEDS_ATTENTION', message, 409),
  idempotencyPayloadMismatch: (
    message = 'This idempotency key was already used with a different payload.',
  ) => new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', message, 409),
  missingIdempotencyKey: (message = 'Idempotency-Key header is required.') =>
    new AppError('MISSING_IDEMPOTENCY_KEY', message, 400),
  faultsDisabled: (message = 'Demo fault controls are disabled on this deployment.') =>
    new AppError('FAULTS_DISABLED', message, 403),
  mockUnreachable: (message = 'The mock notification service could not be reached.') =>
    new AppError('MOCK_UNREACHABLE', message, 502),
  internal: (message = 'An unexpected error occurred.') =>
    new AppError('INTERNAL_ERROR', message, 500),
};

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    details?: unknown;
  };
}

export function errorEnvelope(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: unknown,
): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      requestId,
      ...(details !== undefined ? { details } : {}),
    },
  };
}
