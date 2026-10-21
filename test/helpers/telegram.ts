// Drive a real grammy Bot with fake updates; outgoing Bot API calls are captured, not sent.
import type { Bot } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { SirenContext } from '../../src/bot/context.js';

export const botInfo: UserFromGetMe = {
  id: 123456,
  is_bot: true,
  first_name: 'Siren',
  username: 'siren_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

export type ApiCall = { method: string; payload: Record<string, unknown> };

export function captureApi(bot: Bot<SirenContext>): ApiCall[] {
  const calls: ApiCall[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const result = method === 'sendMessage' ? { message_id: calls.length, date: 0, chat: { id: 0, type: 'group' } } : true;
    return { ok: true, result } as never;
  });
  return calls;
}

export const GROUP = { id: -1001, type: 'supergroup' as const, title: 'Five-a-side' };
export const DAMIAN = { id: 42, is_bot: false, first_name: 'Damian', username: 'damianc' };
export const JAY = { id: 43, is_bot: false, first_name: 'Jay' };

let updateId = 1;

export function textUpdate(text: string, opts: { from?: typeof DAMIAN; chat?: object; replyToBot?: boolean } = {}) {
  const entities = text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] : [];
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: opts.chat ?? GROUP,
      from: opts.from ?? DAMIAN,
      text,
      entities,
      ...(opts.replyToBot ? { reply_to_message: { message_id: 1, date: 0, chat: GROUP, from: botInfo, text: 'hi' } } : {}),
    },
  };
}

export function callbackUpdate(data: string, from: object = DAMIAN) {
  return {
    update_id: updateId++,
    callback_query: {
      id: `cb${updateId}`,
      chat_instance: 'x',
      from,
      data,
      message: { message_id: 99, date: 0, chat: GROUP, text: 'New split card' },
    },
  };
}
