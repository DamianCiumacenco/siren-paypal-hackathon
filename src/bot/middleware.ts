import type { MiddlewareFn } from 'grammy';
import type { ChatRegistry } from '../db/chats.js';
import type { SirenContext } from './context.js';

/**
 * Group auto-register + user resolve. Runs for every message/button tap from a human:
 * upserts the user, and in groups the group + the user's membership. With bot privacy
 * disabled that's every group message, so ids are cached in memory (a renamed user's
 * first_name refreshes on restart — fine for the hackathon).
 */
export function registerChat(registry: ChatRegistry): MiddlewareFn<SirenContext> {
  const users = new Map<number, number>(); // telegram user id → users.id
  const groups = new Map<number, number>(); // telegram chat id → groups.id
  const memberships = new Set<string>();

  return async (ctx, next) => {
    const from = ctx.from;
    if (!from || from.is_bot) return next();

    let userId = users.get(from.id);
    if (userId === undefined) {
      userId = await registry.registerUser({ telegramUserId: from.id, firstName: from.first_name, username: from.username });
      users.set(from.id, userId);
    }

    let groupId: number | undefined;
    const chat = ctx.chat;
    if (chat && (chat.type === 'group' || chat.type === 'supergroup')) {
      groupId = groups.get(chat.id);
      if (groupId === undefined) {
        groupId = await registry.registerGroup(chat.id, chat.title, from.id);
        groups.set(chat.id, groupId);
      }
      const key = `${userId}:${groupId}`;
      if (!memberships.has(key)) {
        await registry.registerMembership(userId, groupId);
        memberships.add(key);
      }
    }

    ctx.siren = { userId, groupId };
    return next();
  };
}
