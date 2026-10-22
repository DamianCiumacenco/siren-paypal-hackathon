export type TelegramState = 'starting' | 'webhook' | 'polling' | 'passive' | 'retrying';

/** Telegram wiring state, set by setupTelegram (server.ts) and reported on /health. */
export const telegramStatus: { state: TelegramState } = { state: 'starting' };
