import type { SupabaseClient } from '@supabase/supabase-js';

export interface TelegramUserInfo {
  telegramUserId: number;
  firstName: string;
  username?: string;
}

export interface ChatRegistry {
  /** Upsert the group by Telegram chat id; returns groups.id. */
  registerGroup(telegramChatId: number, title: string | undefined, createdBy: number): Promise<number>;
  /** Upsert the user by Telegram user id; returns users.id. */
  registerUser(user: TelegramUserInfo): Promise<number>;
  /**
   * Record that this user is in this group. There's no separate members table: a
   * user_memory row per (user, group) doubles as membership and starts at defaults.
   */
  registerMembership(userId: number, groupId: number): Promise<void>;
}

export function createChatRegistry(db: SupabaseClient): ChatRegistry {
  return {
    async registerGroup(telegramChatId, title, createdBy) {
      const { data, error } = await db
        .from('groups')
        .upsert({ telegram_chat_id: telegramChatId, chat_title: title ?? null, created_by: createdBy }, {
          onConflict: 'telegram_chat_id',
          ignoreDuplicates: false,
        })
        .select('id')
        .single();
      if (error) throw new Error(`registerGroup failed: ${error.message}`);
      return Number(data.id);
    },

    async registerUser(user) {
      const { data, error } = await db
        .from('users')
        .upsert(
          { telegram_user_id: user.telegramUserId, first_name: user.firstName, username: user.username ?? null },
          { onConflict: 'telegram_user_id' },
        )
        .select('id')
        .single();
      if (error) throw new Error(`registerUser failed: ${error.message}`);
      return Number(data.id);
    },

    async registerMembership(userId, groupId) {
      const { error } = await db
        .from('user_memory')
        .upsert({ user_id: userId, group_id: groupId }, { onConflict: 'user_id,group_id', ignoreDuplicates: true });
      if (error) throw new Error(`registerMembership failed: ${error.message}`);
    },
  };
}
