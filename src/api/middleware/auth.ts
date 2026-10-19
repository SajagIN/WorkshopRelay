/**
 * Demo bearer-token authentication (PRD §10 — explicit, not production-grade).
 *
 * Tokens are configured in env and mapped to roles via the DemoIdentity table
 * (written by the seed). Identity resolution is a single indexed lookup per
 * request — no caching, so seed changes and token rotation take effect
 * immediately.
 */
import type { NextFunction, Request, Response } from 'express';
import type { Db } from '../../db/client';
import type { Config } from '../../shared/config';
import type { Identity } from '../../domain/types';
import { appErrors } from '../../shared/errors';

export interface AuthedRequest extends Request {
  identity?: Identity;
}

export function createAuthMiddleware(db: Db, _config: Config) {
  return async function authenticate(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const header = req.header('authorization') ?? '';
      const match = /^Bearer\s+(.+)$/i.exec(header.trim());
      if (!match) {
        next(appErrors.unauthorized());
        return;
      }
      const token = match[1].trim();
      const row = await db.demoIdentity.findUnique({ where: { token } });
      if (!row) {
        next(appErrors.unauthorized('Unknown demo token.'));
        return;
      }
      const identity: Identity = {
        token: row.token,
        label: row.label,
        role: row.role === 'ORGANIZER' ? 'ORGANIZER' : 'MEMBER',
        memberId: row.memberId,
      };
      (req as AuthedRequest).identity = identity;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function getIdentity(req: Request): Identity {
  const identity = (req as AuthedRequest).identity;
  if (!identity) throw appErrors.unauthorized();
  return identity;
}

export function requireOrganizer(req: Request, _res: Response, next: NextFunction): void {
  const identity = getIdentity(req);
  if (identity.role !== 'ORGANIZER') {
    next(appErrors.forbidden('Organizer role required.'));
    return;
  }
  next();
}

export function requireMember(req: Request, _res: Response, next: NextFunction): void {
  const identity = getIdentity(req);
  if (!identity.memberId) {
    next(appErrors.notAMember());
    return;
  }
  next();
}
