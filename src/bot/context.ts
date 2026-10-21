import type { Context } from 'grammy';

/** grammy context + what the registration middleware resolved for this update. */
export type SirenContext = Context & {
  siren?: {
    /** users.id of ctx.from */
    userId: number;
    /** groups.id — only in group/supergroup chats */
    groupId?: number;
  };
};
