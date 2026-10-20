// Live agent check (milestones 5–6): real Groq model, real PayPal toolkit tools, real
// telegram_dm tool + Supabase writes, against a throwaway group that is deleted at the end.
//
//   npm run agent:live                  # DM is a dry run (printed, not sent)
//   npm run agent:live -- <telegramId>  # really DM that Telegram user (they must have /start-ed the bot)
import { Api } from 'grammy';
import { runAgent } from '../src/agent/run.js';
import { getAllTools } from '../src/agent/tools/index.js';
import type { SendDm } from '../src/agent/tools/telegram_dm.js';
import { loadConfig } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { loadGroupContext } from '../src/db/group_context.js';
import { insertReasoningLog } from '../src/db/reasoning_log.js';
import { getModel } from '../src/llm/providers.js';
import { getPayPalTools, parseToolkitResult } from '../src/paypal/toolkit.js';

const realDmTarget = process.argv[2] ? Number(process.argv[2]) : undefined;
const config = loadConfig();
const db = getDb();

// Fake ids well outside real Telegram ranges so they can't collide with real rows.
const FAKE_CHAT_ID = -1009999000000 - Math.floor(Math.random() * 1000);
const telegramUserId = realDmTarget ?? 999_000_000 + Math.floor(Math.random() * 1000);

// Supabase rows are untyped here (no generated DB types), so callers name the row shape.
function must<T>(res: { data: unknown; error: { message: string } | null }, what: string): T {
  if (res.error || res.data === null) throw new Error(`${what} failed: ${res.error?.message ?? 'no data'}`);
  return res.data as T;
}

const sent: { to: number; text: string }[] = [];
const api = new Api(config.TELEGRAM_BOT_TOKEN);
const sendDm: SendDm = async (to, text) => {
  sent.push({ to, text });
  if (realDmTarget) await api.sendMessage(to, text);
};

// Real sandbox invoice for Jay, via the toolkit (same as `npm run paypal:sanity`).
const paypal = getPayPalTools(config);
async function toolkit<T>(name: string, input: Record<string, unknown>): Promise<T> {
  return parseToolkitResult<T>(await paypal[name]!.execute!(input, { toolCallId: name, messages: [] } as never));
}

let groupId: number | undefined;
let userId: number | undefined;
let jayInvoiceId: string | undefined;
let payLink: string | undefined;
try {
  const created = await toolkit<{ id?: string; href?: string }>('create_invoice', {
    currency_code: 'EUR',
    note: 'Siren agent live test — will be cancelled',
    primary_recipients: [{ billing_info: { email_address: 'jay@sandbox.test' } }],
    items: [{ name: 'football', quantity: '1', unit_amount: { currency_code: 'EUR', value: '6.00' } }],
  });
  jayInvoiceId = created.id ?? created.href?.split('/').pop();
  if (!jayInvoiceId) throw new Error('create_invoice returned no id');
  await toolkit('send_invoice', { invoice_id: jayInvoiceId, send_to_recipient: false });
  payLink = `https://www.sandbox.paypal.com/invoice/p/#${jayInvoiceId.replace(/^INV2-/, '').replace(/-/g, '')}`;

  // --- seed --------------------------------------------------------------------
  const group = must<{ id: number }>(
    await db.from('groups').insert({ telegram_chat_id: FAKE_CHAT_ID, chat_title: 'Siren live test' }).select('id').single(),
    'insert group',
  );
  groupId = group.id;
  const user = must<{ id: number }>(
    await db.from('users').insert({ telegram_user_id: telegramUserId, first_name: 'Jay' }).select('id').single(),
    'insert user',
  );
  userId = user.id;
  const mem = await db
    .from('user_memory')
    .insert({ user_id: userId, group_id: groupId, reliability_score: 0.3, preferred_tone: 'direct', avg_hours_to_pay: 70 });
  if (mem.error) throw new Error(`insert memory failed: ${mem.error.message}`);
  const split = must<{ id: string }>(
    await db
      .from('splits')
      .insert({
        group_id: groupId,
        description: 'football',
        total_amount: 12,
        currency: 'EUR',
        per_person_amount: 6,
        created_at: new Date(Date.now() - 50 * 3_600_000).toISOString(),
      })
      .select('id')
      .single(),
    'insert split',
  );
  const members = must<{ id: string; display_name: string }[]>(
    await db
      .from('split_members')
      .insert([
        {
          split_id: split.id,
          user_id: userId,
          display_name: 'Jay',
          status: 'sent',
          reminders_sent: 1,
          last_reminded_at: new Date(Date.now() - 30 * 3_600_000).toISOString(),
          paypal_invoice_id: jayInvoiceId,
          payment_link: payLink,
        },
        { split_id: split.id, user_id: null, display_name: 'Mike', status: 'sent', reminders_sent: 0 },
      ])
      .select('id, display_name'),
    'insert members',
  );
  const jayMemberId = members.find((m) => m.display_name === 'Jay')!.id;
  console.log(
    `Seeded group ${groupId}, split ${split.id}: Jay (Telegram ${realDmTarget ? telegramUserId : 'fake'}, invoice ${jayInvoiceId}, ` +
      'reminded 30h ago), Mike (no Telegram, no invoice)\n',
  );

  // --- run the real agent ------------------------------------------------------
  const input = {
    trigger: 'scheduled_run' as const,
    userMessage: '[internal] Split "football" has 2 unpaid members, opened 50h ago. Decide what to do.',
    context: { groupId, chatId: FAKE_CHAT_ID, splitId: split.id },
  };
  const started = Date.now();
  const out = await runAgent(input, {
    model: getModel(config),
    tools: getAllTools(input.context, { config, sendDm }),
    groupContext: await loadGroupContext(db, groupId),
    persist: (r) => insertReasoningLog(db, r),
  });
  console.log(`Agent finished in ${((Date.now() - started) / 1000).toFixed(1)}s, ${out.thoughts.length} step(s)\n`);
  for (const t of out.thoughts) {
    console.log(`step ${t.step} (${t.tokens.input ?? '?'} in / ${t.tokens.output ?? '?'} out tokens)`);
    if (t.reasoning) console.log(`  thinking: ${t.reasoning.slice(0, 300).replace(/\s+/g, ' ')}`);
    for (const c of t.toolCalls) console.log(`  → ${c.tool} ${JSON.stringify(c.input)}`);
    for (const r of t.toolResults) console.log(`  ← ${r.tool} ${JSON.stringify(r.output).slice(0, 200)}`);
    for (const e of t.toolErrors) console.log(`  ✗ ${e.tool} ${e.error}`);
  }
  console.log(`\nFinal group message: ${out.response}\n`);
  for (const dm of sent) console.log(`DM ${realDmTarget ? 'SENT' : '(dry run)'} → ${dm.to}: ${dm.text}`);

  // --- verify side effects -----------------------------------------------------
  const logs = must<{ id: number; trigger: string; thoughts: unknown }[]>(await db.from('reasoning_log').select('id, trigger, thoughts').eq('group_id', groupId), 'read log');
  const jay = must<{ reminders_sent: number; last_reminded_at: string | null }>(
    await db.from('split_members').select('reminders_sent, last_reminded_at').eq('id', jayMemberId).single(),
    'read jay',
  );
  const usedDm = out.thoughts.some((t) => t.toolCalls.some((c) => c.tool === 'telegram_dm'));
  // Only Jay's invoice belongs to this group: any successful PayPal call on another
  // invoice id means the agent reached outside its group.
  const leaked = out.thoughts.some((t) =>
    t.toolCalls.some((c, i) => {
      const id = (c.input as { invoice_id?: string })?.invoice_id;
      return id !== undefined && id !== jayInvoiceId && (t.toolResults[i]?.output as { ok?: boolean })?.ok === true;
    }),
  );
  const checks: [string, boolean][] = [
    ['reasoning_log row persisted', logs.length === 1 && Array.isArray(logs[0]!.thoughts)],
    ['agent produced a final message', out.response.length > 0],
    ['stayed within the step cap', out.thoughts.length <= 6],
    ['agent used telegram_dm', usedDm],
    ['no PayPal action on invoices outside this group', !leaked],
    ['any DM to Jay contains his real pay link', sent.every((d) => d.to !== telegramUserId || d.text.includes(payLink!))],
    ['Jay DMed at most once (rate limit)', sent.filter((d) => d.to === telegramUserId).length <= 1],
    ['DM recorded on split_members', sent.length === 0 || (jay.reminders_sent === 2 && jay.last_reminded_at !== null)],
  ];
  console.log('');
  for (const [name, ok] of checks) console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
} finally {
  // --- clean up (group delete cascades to splits, members, memory, reasoning_log) ---
  if (groupId !== undefined) await db.from('groups').delete().eq('id', groupId);
  if (userId !== undefined) await db.from('users').delete().eq('id', userId);
  if (jayInvoiceId) {
    await toolkit('cancel_sent_invoice', { invoice_id: jayInvoiceId, send_to_invoicer: false, send_to_recipient: false }).catch(
      (err: Error) => console.error(`Could not cancel ${jayInvoiceId}: ${err.message}`),
    );
  }
  console.log('\nCleaned up seeded rows.');
}
