/**
 * E2E harness (milestone 14): drives the LIVE Render deployment.
 *
 *   suite ──POST /webhook/telegram (real secret, synthetic update)──▶ Render
 *         ◀─GET /e2e/outbox (what the bot "sent" to our throwaway chats)─ Render
 *         ──POST /e2e/scheduler-pass (one pass, this test group only)──▶ Render
 *         ──toolkit record_payment_for_invoice ─▶ PayPal ─real webhook─▶ Render
 *         ──Supabase (seed history/memory, assert rows)
 *
 * Telegram is the only thing mocked: the throwaway group/users don't exist on Telegram,
 * so production's sink (src/e2e/sink.ts) captures messages to them. PayPal, the LLM chain,
 * the webhook signature check and the database are all real.
 *
 * Fail loud: a missing E2E_SECRET, an unreachable server or a server without the e2e
 * routes throws, failing the file. Nothing is ever skipped.
 */
import { createHash } from 'node:crypto';
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';
import { createClient } from '@supabase/supabase-js';
import { loadConfig } from '../../src/config.js';
import type { SinkMessage } from '../../src/e2e/sink.js';
import { adaptToolkitTools, executeToolkit } from '../../src/paypal/toolkit.js';
import type { PassResult } from '../../src/scheduler/runner.js';

export const BASE_URL = (process.env.E2E_BASE_URL ?? 'https://siren-5brb.onrender.com').replace(/\/+$/, '');
const config = loadConfig();
if (!config.E2E_SECRET) throw new Error('E2E_SECRET is not set in .env.local (it must match Render). See .env.example.');
const E2E_SECRET = config.E2E_SECRET;
const TELEGRAM_SECRET = createHash('sha256').update(`siren-webhook:${config.TELEGRAM_BOT_TOKEN}`).digest('hex');
export const db = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);

// Test-only toolkit: recordPayment stands in for a payer clicking "Pay" (no sandbox
// buyer passwords or browser in CI). It makes PayPal send the same signed
// INVOICING.INVOICE.PAID webhook to Render. The agent never gets this action.
const paypal = adaptToolkitTools(
  new PayPalAgentToolkit({
    clientId: config.PAYPAL_CLIENT_ID,
    clientSecret: config.PAYPAL_CLIENT_SECRET,
    configuration: { actions: { invoices: { recordPayment: true, cancel: true } }, context: { sandbox: true } },
  }).getTools() as Record<string, unknown>,
) as Record<string, Parameters<typeof executeToolkit>[0]>;

/** The SETUP.md §1.5 sandbox Personal accounts. Invoices are addressed to these. */
export const SANDBOX_EMAIL: Record<string, string> = {
  Damian: 'damian@sandbox.test',
  Jay: 'jay@sandbox.test',
  Sean: 'sean@sandbox.test',
  Mike: 'mike@sandbox.test',
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = () => Math.floor(Math.random() * 1e6);

async function http<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    body: init.json === undefined ? init.body : JSON.stringify(init.json),
    headers: { 'x-e2e-secret': E2E_SECRET, ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

let botUsername: string | undefined;
/** Fails loud unless the live server is up, in webhook mode, and has the e2e routes. */
export async function preflight(): Promise<void> {
  const health = await http<{ ok: boolean; telegram: string }>('/health');
  if (!health.body?.ok) throw new Error(`${BASE_URL}/health is not ok (HTTP ${health.status})`);
  if (health.body.telegram !== 'webhook') throw new Error(`Production Telegram state is "${health.body.telegram}", expected "webhook"`);
  const probe = await http('/e2e/outbox?chat=1');
  if (probe.status === 401) throw new Error('E2E_SECRET in .env.local does not match the one on Render');
  if (probe.status !== 404 || (probe.body as { error?: string })?.error !== 'chat not registered') {
    throw new Error(`/e2e routes missing on ${BASE_URL} (HTTP ${probe.status}) — set E2E_SECRET on Render and redeploy`);
  }
  if (!botUsername) {
    const me = (await (await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getMe`)).json()) as { result: { username: string } };
    botUsername = me.result.username;
  }
}
export const bot = () => botUsername!;

export interface Person {
  name: string;
  tgId: number;
  userId: number;
}

/** One throwaway Telegram group + people, registered with production's sink. */
export class World {
  readonly chatId = -1009999000000 - rand();
  groupId!: number;
  readonly people: Record<string, Person> = {};
  private updateId = 900_000_000 + rand() * 100;
  private callbackN = 0;

  static async create(title: string, names: string[]): Promise<World> {
    await preflight();
    const w = new World();
    for (const name of names) w.people[name] = { name, tgId: 999_000_000 + rand(), userId: 0 };
    const reg = await http('/e2e/register', { method: 'POST', json: { chatIds: [w.chatId, ...Object.values(w.people).map((p) => p.tgId)] } });
    if (reg.status !== 200) throw new Error(`register failed: HTTP ${reg.status}`);
    // Everyone says hi in the group: production's registration middleware creates the
    // group, the users and their memberships — the same path real members take.
    for (const name of names) await w.say(name, 'hi', { title });
    for (const p of Object.values(w.people)) {
      const row = await waitFor(`user ${p.name} registered`, async () => {
        const { data } = await db.from('users').select('id').eq('telegram_user_id', p.tgId).maybeSingle();
        return data ? Number(data.id) : undefined;
      });
      p.userId = row;
      await db.from('users').update({ paypal_email: SANDBOX_EMAIL[p.name] ?? null }).eq('id', row);
    }
    w.groupId = await waitFor('group registered', async () => {
      const { data } = await db.from('groups').select('id').eq('telegram_chat_id', w.chatId).maybeSingle();
      return data ? Number(data.id) : undefined;
    });
    // Memberships are written right after the group; make sure all of them landed.
    await waitFor('memberships registered', async () => {
      const { data } = await db.from('user_memory').select('user_id').eq('group_id', w.groupId);
      return (data?.length ?? 0) >= names.length ? true : undefined;
    });
    return w;
  }

  p(name: string): Person {
    const p = this.people[name];
    if (!p) throw new Error(`no person ${name} in this world`);
    return p;
  }

  private from(name: string) {
    return { id: this.p(name).tgId, is_bot: false, first_name: name };
  }

  /** A group message from `name`, delivered to production exactly as Telegram would. */
  async say(name: string, text: string, opts: { title?: string } = {}): Promise<void> {
    const command = /^\/\w+(@\w+)?/.exec(text);
    await deliver({
      update_id: this.updateId++,
      message: {
        message_id: this.updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: this.chatId, type: 'supergroup', title: opts.title ?? 'Siren e2e' },
        from: this.from(name),
        text,
        ...(command ? { entities: [{ type: 'bot_command', offset: 0, length: command[0].length }] } : {}),
      },
    });
  }

  /** `name` taps an inline button (callback_data) on a card the bot posted. */
  async tap(name: string, data: string, card: SinkMessage): Promise<void> {
    await deliver({
      update_id: this.updateId++,
      callback_query: {
        id: `e2e:${this.chatId}:${++this.callbackN}`, // the sink captures answers to e2e:<chat>:… ids
        from: this.from(name),
        chat_instance: 'e2e',
        data,
        message: {
          message_id: 1,
          date: Math.floor(Date.now() / 1000),
          chat: { id: this.chatId, type: 'supergroup', title: 'Siren e2e' },
          from: { id: 1, is_bot: true, first_name: 'Siren', username: bot() },
          text: card.text,
        },
      },
    });
  }

  groupOutbox(): Promise<SinkMessage[]> {
    return outbox(this.chatId);
  }

  dms(name: string): Promise<SinkMessage[]> {
    return outbox(this.p(name).tgId).then((m) => m.filter((x) => x.method === 'sendMessage'));
  }

  /** Wait for the first group sendMessage matching `pattern` (newer than `after` messages). */
  async groupMessage(pattern: RegExp, what: string, after = 0, timeoutMs = 150_000, filter: (m: SinkMessage) => boolean = () => true): Promise<SinkMessage> {
    return waitFor(
      what,
      async () =>
        (await this.groupOutbox()).filter((m) => m.method === 'sendMessage').slice(after).find((m) => filter(m) && pattern.test(m.text ?? '')),
      timeoutMs,
    );
  }

  /** The ✅/❌ confirmation card: the message WITH buttons (the agent's own reply mentions ✅ too). */
  card(after = 0): Promise<SinkMessage> {
    return this.groupMessage(/tap ✅ to send/, 'confirmation card (with buttons)', after, 150_000, (m) => (m.buttons?.length ?? 0) > 0);
  }

  async groupMessageCount(): Promise<number> {
    return (await this.groupOutbox()).filter((m) => m.method === 'sendMessage').length;
  }

  schedulerPass(): Promise<PassResult> {
    return http<PassResult>('/e2e/scheduler-pass', { method: 'POST', json: { chatId: this.chatId } }).then((r) => {
      if (r.status !== 200) throw new Error(`scheduler-pass failed: HTTP ${r.status} ${JSON.stringify(r.body)}`);
      return r.body;
    });
  }

  /** A draft split exactly as send_split_invoices saves it (status draft, members pending). */
  async seedDraft(description: string, total: number, debtors: string[], creator = 'Damian'): Promise<string> {
    const per = Math.round((total / (debtors.length + 1)) * 100) / 100;
    const { data, error } = await db
      .from('splits')
      .insert({ group_id: this.groupId, creator_user_id: this.p(creator).userId, description, total_amount: total, per_person_amount: per, currency: 'EUR', status: 'draft' })
      .select('id')
      .single();
    if (error) throw new Error(`seed draft: ${error.message}`);
    const members = debtors.map((n) => ({ split_id: data.id, user_id: this.p(n).userId, display_name: n, status: 'pending' }));
    const ins = await db.from('split_members').insert(members);
    if (ins.error) throw new Error(`seed members: ${ins.error.message}`);
    return String(data.id);
  }

  /** Draft → ✅ by the creator through production → real sandbox invoices for everyone. */
  async openSplitViaCard(description: string, total: number, debtors: string[], creator = 'Damian'): Promise<{ splitId: string; members: MemberRow[] }> {
    const splitId = await this.seedDraft(description, total, debtors, creator);
    const card = { method: 'sendMessage', chatId: this.chatId, text: `New split: ${description}`, at: new Date().toISOString() };
    await this.tap(creator, `split:confirm:${splitId}`, card);
    const members = await waitFor(
      `invoices for "${description}"`,
      async () => {
        const rows = await memberRows(splitId);
        return rows.length === debtors.length && rows.every((r) => r.paypal_invoice_id && r.status === 'sent') ? rows : undefined;
      },
      120_000,
    );
    return { splitId, members };
  }

  /** Delete everything this world created; cancel any sandbox invoice still unpaid. */
  async cleanup(): Promise<void> {
    if (this.groupId) {
      const { data: splits } = await db.from('splits').select('id').eq('group_id', this.groupId);
      for (const s of splits ?? []) {
        for (const m of await memberRows(String(s.id))) {
          if (m.paypal_invoice_id && m.status !== 'paid') {
            await executeToolkit(paypal.cancel_sent_invoice!, { invoice_id: m.paypal_invoice_id, send_to_invoicer: false, send_to_recipient: false }).catch(() => {});
          }
        }
      }
      await db.from('groups').delete().eq('id', this.groupId); // cascades to splits, members, memory, reasoning_log
    }
    for (const p of Object.values(this.people)) if (p.userId) await db.from('users').delete().eq('id', p.userId);
  }
}

export interface MemberRow {
  id: string;
  display_name: string;
  user_id: number | null;
  status: string;
  paypal_invoice_id: string | null;
  payment_link: string | null;
  reminders_sent: number;
  last_reminded_at: string | null;
}

export async function memberRows(splitId: string): Promise<MemberRow[]> {
  const { data, error } = await db
    .from('split_members')
    .select('id, display_name, user_id, status, paypal_invoice_id, payment_link, reminders_sent, last_reminded_at')
    .eq('split_id', splitId);
  if (error) throw new Error(`member rows: ${error.message}`);
  return data as MemberRow[];
}

/** The payer pays: recorded on the invoice, PayPal then sends INVOICING.INVOICE.PAID to Render. */
export async function payInvoice(invoiceId: string, amount: number): Promise<void> {
  await executeToolkit(paypal.record_payment_for_invoice!, {
    invoice_id: invoiceId,
    method: 'PAYPAL',
    amount: { currency_code: 'EUR', value: amount.toFixed(2) },
  });
}

async function deliver(update: unknown): Promise<void> {
  const res = await fetch(`${BASE_URL}/webhook/telegram`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': TELEGRAM_SECRET },
    body: JSON.stringify(update),
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status !== 200) throw new Error(`Telegram webhook answered HTTP ${res.status}`);
}

async function outbox(chatId: number): Promise<SinkMessage[]> {
  const r = await http<{ messages: SinkMessage[] }>(`/e2e/outbox?chat=${chatId}`);
  if (r.status !== 200) throw new Error(`outbox(${chatId}) HTTP ${r.status}`);
  return r.body.messages;
}

/** Poll until `fn` returns a value; throw with `what` on timeout (fail loud). */
export async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 60_000, everyMs = 2_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for: ${what}`);
    await sleep(everyMs);
  }
}

/** Groq free tier = 8k tokens/min; space out the LLM-heavy steps (failover covers the rest). */
export const llmBreather = () => sleep(20_000);
