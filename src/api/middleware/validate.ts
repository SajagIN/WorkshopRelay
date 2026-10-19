import type { ZodType } from 'zod';
import type { Request } from 'express';
import { appErrors } from '../../shared/errors';

/** Parse `data` with `schema`, converting Zod issues into a 400 envelope. */
export function parseOrThrow<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({
      path: i.path.join('.') || '(root)',
      message: i.message,
    }));
    throw appErrors.validation('Request validation failed.', details);
  }
  return result.data;
}

/** Express 5 params are typed `string | string[]`; routes need a plain string. */
export function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw appErrors.notFound(`Missing route parameter "${name}".`);
  }
  return value;
}
