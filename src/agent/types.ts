export type AgentTrigger = 'user_message' | 'scheduled_run' | 'webhook';

/** Who/where the agent is acting for. Tools are scoped to this — never cross-group. */
export interface AgentContext {
  /** groups.id (our DB id, not the Telegram chat id). */
  groupId: number;
  /** Telegram chat id of the group, for posting back. */
  chatId: number;
  splitId?: string;
  /** Telegram user who sent the message (user_message trigger only). */
  sender?: { telegramUserId: number; firstName: string; username?: string; /** users.id */ userId: number };
  /** ISO country code used for currency slang ("quid"). Defaults to IE. */
  senderCountry?: string;
}

export interface AgentInput {
  trigger: AgentTrigger;
  userMessage: string;
  context: AgentContext;
}

/** Snapshot of the group injected into the system prompt on every call. */
export interface GroupContext {
  chatTitle?: string;
  members: {
    userId: number;
    name: string;
    username?: string;
    reliabilityScore?: number | null;
    preferredTone?: 'chill' | 'neutral' | 'direct' | null;
    avgHoursToPay?: number | null;
  }[];
  openSplits: {
    id: string;
    description: string | null;
    currency: string;
    totalAmount: number | null;
    perPersonAmount: number | null;
    createdAt: string;
    members: {
      splitMemberId: string;
      name: string;
      userId: number | null;
      status: string;
      invoiceId: string | null;
      paymentLink: string | null;
      remindersSent: number;
      lastRemindedAt: string | null;
    }[];
  }[];
  recentReasoning: { trigger: string | null; finalResponse: string | null; createdAt: string }[];
}
