import { APICallError, RetryError } from 'ai';
import { GrammyError, HttpError } from 'grammy';

/**
 * HARD RULE: errors reach logs only through safeErrorMessage / logError.
 *
 * Raw SDK errors carry PII. An ai-sdk APICallError includes `requestBodyValues` (the
 * whole prompt: member names, amounts, the user's message) and `responseBody`; a
 * RetryError nests several of those. grammy errors carry the request payload (DM text).
 * Printing the error object — console.error(err), log.error({ err }) — dumps all of it.
 * These helpers keep only status codes and provider error messages.
 */

const MAX_CHARS = 300;
const clip = (s: string) => (s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}…` : s);

/** Provider error text from an APICallError body ({"error":{"message":...}}), never the request. */
function providerMessage(err: APICallError): string | undefined {
  const data = err.data as { error?: { message?: unknown } } | undefined;
  if (typeof data?.error?.message === 'string') return data.error.message;
  try {
    const parsed = JSON.parse(err.responseBody ?? '') as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === 'string') return parsed.error.message;
  } catch {
    /* not JSON */
  }
  return undefined;
}

export function safeErrorMessage(err: unknown): string {
  if (RetryError.isInstance(err)) {
    return clip(`RetryError after ${err.errors.length} attempts (${err.reason}): ${safeErrorMessage(err.lastError)}`);
  }
  if (APICallError.isInstance(err)) {
    return clip(`APICallError ${err.statusCode ?? '?'}: ${providerMessage(err) ?? 'no provider message'}`);
  }
  if (err instanceof GrammyError) {
    return clip(`Telegram ${err.method} failed: ${err.error_code} ${err.description}`);
  }
  if (err instanceof HttpError) return clip(`Telegram network error: ${safeErrorMessage(err.error)}`);
  if (err instanceof Error) return clip(`${err.name}: ${err.message}`);
  return 'unknown error';
}

/** Minimal logger shape (pino's, as used by Fastify) so tests can capture output. */
export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/**
 * Log an error with ids only. `ids` must be identifiers (chat id, update id, split id),
 * never message text, names or amounts.
 */
export function logError(log: Logger, err: unknown, msg: string, ids: Record<string, string | number | undefined> = {}) {
  log.error({ ...ids, error: safeErrorMessage(err) }, msg);
}
