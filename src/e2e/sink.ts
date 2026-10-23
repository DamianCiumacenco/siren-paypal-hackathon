import type { Transformer } from 'grammy';

/**
 * E2E Telegram sink (milestone 14, only when E2E_SECRET is set).
 *
 * The e2e suite drives the LIVE server with synthetic Telegram updates from throwaway
 * groups/users that don't exist on Telegram, so the bot's replies, DMs and cards to them
 * would fail. The suite registers those chat ids first (POST /e2e/register); outgoing
 * Bot API calls aimed at a registered chat are recorded here and answered with a fake
 * success instead of being sent. Every other chat goes to Telegram exactly as before.
 * Registrations expire after REGISTRATION_TTL_MS, so nothing stays captured by accident.
 *
 * Callback query ids the suite sends look like `e2e:<chatId>:<n>`; answerCallbackQuery for
 * those is captured too (it carries no chat_id).
 */

export const REGISTRATION_TTL_MS = 30 * 60_000;
const MAX_MESSAGES = 1_000;

export interface SinkMessage {
  method: string;
  chatId: number;
  text?: string;
  /** Inline keyboard button callback_data, flattened (✅/❌ cards). */
  buttons?: string[];
  at: string;
}

type Payload = Record<string, unknown>;

export class TelegramSink {
  private readonly chats = new Map<number, number>(); // chat id → expires at (ms)
  private messages: SinkMessage[] = [];
  private nextMessageId = 1;

  constructor(private readonly now: () => number = Date.now) {}

  register(chatIds: number[]): void {
    const expires = this.now() + REGISTRATION_TTL_MS;
    for (const id of chatIds) this.chats.set(id, expires);
  }

  isRegistered(chatId: number): boolean {
    const expires = this.chats.get(chatId);
    if (expires === undefined) return false;
    if (expires > this.now()) return true;
    this.chats.delete(chatId);
    this.messages = this.messages.filter((m) => m.chatId !== chatId);
    return false;
  }

  outbox(chatId: number): SinkMessage[] {
    return this.isRegistered(chatId) ? this.messages.filter((m) => m.chatId === chatId) : [];
  }

  /** The chat a Bot API call is aimed at, if it's one the suite registered. */
  private target(method: string, payload: Payload): number | undefined {
    if (method === 'answerCallbackQuery') {
      const m = /^e2e:(-?\d+):/.exec(String(payload.callback_query_id ?? ''));
      return m && this.isRegistered(Number(m[1])) ? Number(m[1]) : undefined;
    }
    const id = Number(payload.chat_id);
    return Number.isSafeInteger(id) && this.isRegistered(id) ? id : undefined;
  }

  private record(method: string, chatId: number, payload: Payload): unknown {
    const keyboard = (payload.reply_markup as { inline_keyboard?: { callback_data?: string }[][] } | undefined)?.inline_keyboard;
    this.messages.push({
      method,
      chatId,
      text: typeof payload.text === 'string' ? payload.text : undefined,
      buttons: keyboard?.flat().flatMap((b) => (b.callback_data ? [b.callback_data] : [])),
      at: new Date(this.now()).toISOString(),
    });
    if (this.messages.length > MAX_MESSAGES) this.messages = this.messages.slice(-MAX_MESSAGES);

    if (method === 'sendMessage' || method === 'editMessageText') {
      return {
        message_id: method === 'editMessageText' ? Number(payload.message_id) : this.nextMessageId++,
        date: Math.floor(this.now() / 1000),
        chat: { id: chatId, type: chatId < 0 ? 'supergroup' : 'private' },
        text: payload.text,
      };
    }
    return true; // sendChatAction, answerCallbackQuery, editMessageReplyMarkup, …
  }

  /** grammy API transformer: `bot.api.config.use(sink.transformer())`. */
  transformer(): Transformer {
    return async (prev, method, payload, signal) => {
      const chatId = this.target(method, payload as Payload);
      if (chatId === undefined) return prev(method, payload, signal);
      // grammy's ApiResponse type is generic per method; the fake result has the shape used.
      return { ok: true, result: this.record(method, chatId, payload as Payload) } as never;
    };
  }
}
