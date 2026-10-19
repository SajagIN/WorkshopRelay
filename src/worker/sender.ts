/**
 * HTTP sender for the worker. The only place the notification service is
 * contacted — never on the API request path.
 */
import type { DeliveryBody } from '../domain/types';
import {
  classifyHttpStatus,
  classifyThrownError,
  parseRetryAfterMs,
  type SendOutcome,
} from '../domain/retryPolicy';

export interface NotificationSender {
  send(body: DeliveryBody, idempotencyKey: string): Promise<SendOutcome>;
}

export interface HttpSenderOptions {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export function createHttpSender(options: HttpSenderOptions): NotificationSender {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = options.baseUrl.replace(/\/$/, '') + '/notifications';

  return {
    async send(body: DeliveryBody, idempotencyKey: string): Promise<SendOutcome> {
      let response: globalThis.Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
            authorization: `Bearer ${options.token}`,
            'x-request-id': idempotencyKey,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch (err) {
        return classifyThrownError(err);
      }

      const text = await response.text().catch(() => '');
      const outcome = classifyHttpStatus(response.status, text);
      if (outcome.kind === 'transient') {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        return { ...outcome, retryAfterMs };
      }
      return outcome;
    },
  };
}
