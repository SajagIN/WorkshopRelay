/**
 * Central error rendering. Every error leaves the API as the documented
 * envelope: { error: { code, message, requestId, details? } }.
 * SQL/driver internals are never leaked to clients.
 */
import type { NextFunction, Request, Response } from 'express';
import { AppError, errorEnvelope, appErrors } from '../../shared/errors';
import type { Logger } from '../../shared/logger';

export function errorHandler(logger: Logger) {
  return function onerror(
    err: unknown,
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (res.headersSent) {
      next(err);
      return;
    }
    const requestId = (res.locals.requestId as string | undefined) ?? 'unknown';

    const appError = normalizeError(err);
    const logBindings = {
      requestId,
      method: req.method,
      path: req.originalUrl,
      code: appError.code,
      status: appError.status,
    };
    if (appError.status >= 500) {
      logger.error(appError.message, { ...logBindings, err });
    } else {
      logger.info(appError.message, logBindings);
    }

    res
      .status(appError.status)
      .json(errorEnvelope(appError.code, appError.message, requestId, appError.details));
  };
}

function normalizeError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  // express.json() parse/size errors
  const anyErr = err as { type?: string; status?: number; message?: string } | null;
  if (anyErr && anyErr.type === 'entity.too.large') {
    return appErrors.payloadTooLarge();
  }
  if (anyErr && anyErr.type === 'entity.parse.failed') {
    return appErrors.invalidJson();
  }
  if (err instanceof SyntaxError && 'body' in (err as object)) {
    return appErrors.invalidJson();
  }

  return appErrors.internal();
}
