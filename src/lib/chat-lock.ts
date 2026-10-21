/**
 * One agent run per group at a time, shared by user messages and the scheduler, so a
 * scheduled check never races a user's /nag in the same group (double reminders,
 * interleaved replies) and a group can't burn two runs' worth of LLM quota at once.
 */
export class ChatLock {
  private readonly busy = new Set<number>();

  tryAcquire(chatId: number): boolean {
    if (this.busy.has(chatId)) return false;
    this.busy.add(chatId);
    return true;
  }

  release(chatId: number): void {
    this.busy.delete(chatId);
  }
}
