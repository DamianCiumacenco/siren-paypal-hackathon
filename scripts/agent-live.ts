// Live agent check: real Groq model, real PayPal toolkit (sandbox), real Supabase, against a
// throwaway group that is deleted at the end (every invoice it created is cancelled).
//
//   npm run agent:live                      # both scenarios, DMs are dry runs (printed, not sent)
//   npm run agent:live -- --scenario split  # nag | split
//   npm run agent:live -- --dm <telegramId> # really DM that Telegram user (must have /start-ed the bot)
//
// Groq free tier = 8k tokens/min: the script waits between scenarios.
import { Api } from 'grammy';
import { findSplitProposal, runAgent, type AgentOutput } from '../src/agent/run.js';
import { getAllTools } from '../src/agent/tools/index.js';
import type { SendDm } from '../src/agent/tools/telegram_dm.js';
import type { AgentInput } from '../src/agent/types.js';
import { loadConfig } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { loadGroupContext } from '../src/db/group_context.js';
import { insertReasoningLog } from '../src/db/reasoning_log.js';
import { createSplitStore } from '../src/db/splits.js';
import { safeErrorMessage, type Logger } from '../src/lib/safe-error.js';
import { getModel } from '../src/llm/providers.js';
import { formatSendSummary, sendSplitInvoices } from '../src/paypal/split_invoices.js';
import { executeToolkit, getPayPalTools } from '../src/paypal/toolkit.js';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const scenario = arg('scenario') ?? 'all';
const realDmTarget = arg('dm') ? Number(arg('dm')) : undefined;

const config = loadConfig();
const db = getDb();
const paypal = getPayPalTools(config);
const splits = createSplitStore(db);
const log: Logger = { info: () => {}, warn: (o, m) => console.warn(m, o), error: (o, m) => console.error(m, o) };

// Fake ids well outside real Telegram ranges so they can't collide with real rows.
const rand = () => Math.floor(Math.random() * 100_000);
const FAKE_CHAT_ID = -1009999000000 - rand();
const DAMIAN_TG = 999_100_000 + rand();
const JAY_TG = realDmTarget ?? 999_200_000 + rand();

// Supabase rows are untyped here (no generated DB types), so callers name the row shape.
function must<T>(res: { data: unknown; error: { message: string } | null }, what: string): T {
  if (res.error || res.data === null) throw new Error(`${what} failed: ${res.error?.message ?? 'no data'}`);
  return res.data as T;
}

const sent: { to: number; text: string }[] = [];
const api = new Api(config.TELEGRAM_BOT_TOKEN);
const sendDm: SendDm = async (to, text) => {
  sent.push({ to, text });
  if (realDmTarget && to === realDmTarget) await api.sendMessage(to, text);
};

const createdInvoices = new Set<string>();
const checks: [string, boolean][] = [];
const check = (name: string, ok: boolean) => {
  checks.push([name, ok]);
  console.log(`${ok ? '✓' : '✗'} ${name}`);
};

function printRun(out: AgentOutput, seconds: number) {
  console.log(`Agent finished in ${seconds.toFixed(1)}s, ${out.thoughts.length} step(s)`);
  for (const t of out.thoughts) {
    console.log(`  step ${t.step} (${t.tokens.input ?? '?'} in / ${t.tokens.output ?? '?'} out tokens)`);
    for (const c of t.toolCalls) console.log(`    → ${c.tool} ${JSON.stringify(c.input)}`);
    for (const r of t.toolResults) console.log(`    ← ${r.tool} ${JSON.stringify(r.output).slice(0, 220)}`);
    for (const e of t.toolErrors) console.log(`    ✗ ${e.tool} ${e.error}`);
  }
  console.log(`  Group reply: ${out.response}\n`);
}

async function agent(input: AgentInput) {
  const started = Date.now();
  const out = await runAgent(input, {
    model: getModel(config),
    tools: getAllTools(input.context, { config, sendDm }),
    groupContext: await loadGroupContext(db, input.context.groupId),
    persist: (r) => insertReasoningLog(db, r),
  });
  printRun(out, (Date.now() - started) / 1000);
  return out;
}

let groupId: number | undefined;
const userIds: number[] = [];
try {
  // --- seed: group with Damian (sender) and Jay as known members ----------------
  groupId = must<{ id: number }>(
    await db.from('groups').insert({ telegram_chat_id: FAKE_CHAT_ID, chat_title: 'Siren live test' }).select('id').single(),
    'insert group',
  ).id;
  for (const [tg, name, tone, score] of [
    [DAMIAN_TG, 'Damian', 'neutral', 0.9],
    [JAY_TG, 'Jay', 'direct', 0.3],
  ] as const) {
    const id = must<{ id: number }>(
      await db.from('users').insert({ telegram_user_id: tg, first_name: name }).select('id').single(),
      `insert ${name}`,
    ).id;
    userIds.push(id);
    const mem = await db
      .from('user_memory')
      .insert({ user_id: id, group_id: groupId, preferred_tone: tone, reliability_score: score, avg_hours_to_pay: 70 });
    if (mem.error) throw new Error(`insert memory failed: ${mem.error.message}`);
  }
  const [damianId, jayId] = userIds as [number, number];
  console.log(`Seeded group ${groupId}: Damian (sender), Jay (direct tone, reliability 0.3)\n`);

  // --- scenario: split ---------------------------------------------------------
  if (scenario === 'all' || scenario === 'split') {
    console.log('=== split: "/split €18 football with Jay and Mike"');
    const out = await agent({
      trigger: 'user_message',
      userMessage: '/split €18 football with Jay and Mike',
      context: {
        groupId,
        chatId: FAKE_CHAT_ID,
        sender: { telegramUserId: DAMIAN_TG, firstName: 'Damian', userId: damianId },
      },
    });
    const proposal = findSplitProposal(out.thoughts);
    check('agent proposed a split via send_split_invoices', proposal !== undefined);
    check(
      'agent did not claim requests were sent',
      !/requests? (were|have been) sent|sent (the )?(paypal )?requests/i.test(out.response),
    );
    if (proposal) {
      const draft = must<{ status: string; per_person_amount: number }>(
        await db.from('splits').select('status, per_person_amount').eq('id', proposal.splitId).single(),
        'read draft',
      );
      check(
        'split saved as draft, €6.00 each (3 people incl. sender)',
        draft.status === 'draft' && Number(draft.per_person_amount) === 6,
      );
      check('nothing sent before ✅', sent.length === 0);

      console.log('--- simulating ✅ taps');
      check('non-creator cannot confirm', (await splits.confirmDraft(proposal.splitId, JAY_TG)) === null);
      const confirmed = await splits.confirmDraft(proposal.splitId, DAMIAN_TG);
      check('creator confirms (draft → open)', confirmed !== null);
      check('double tap is a no-op', (await splits.confirmDraft(proposal.splitId, DAMIAN_TG)) === null);
      if (confirmed) {
        const result = await sendSplitInvoices(confirmed, { paypal, store: splits, sendDm, log });
        console.log(`\n${formatSendSummary(confirmed.description, result)}\n`);
        const members = must<
          { display_name: string; paypal_invoice_id: string | null; payment_link: string | null; status: string }[]
        >(
          await db
            .from('split_members')
            .select('display_name, paypal_invoice_id, payment_link, status')
            .eq('split_id', proposal.splitId),
          'read members',
        );
        for (const m of members) if (m.paypal_invoice_id) createdInvoices.add(m.paypal_invoice_id);
        check(
          'a real sandbox invoice + pay link stored for each of Jay and Mike',
          members.length === 2 &&
            members.every((m) => m.paypal_invoice_id && m.payment_link?.startsWith('https://www.sandbox.paypal.com/invoice/p/#')),
        );
        const jayLink = members.find((m) => m.display_name === 'Jay')?.payment_link ?? '∅';
        check('Jay got his own pay link by DM', sent.some((d) => d.to === JAY_TG && d.text.includes(jayLink)));
        check('Mike (not in group) got his link posted in the group', result.linkInGroup.some((l) => l.name === 'Mike'));
      }
    }
    if (scenario === 'all') {
      console.log('\n(waiting 60s for the Groq tokens-per-minute window)\n');
      await new Promise((r) => setTimeout(r, 60_000));
    }
  }

  // --- scenario: nag (scheduled run on an open split Jay hasn't paid) ------------
  if (scenario === 'all' || scenario === 'nag') {
    console.log('=== nag: scheduled run, Jay unpaid for 50h, last reminded 30h ago');
    const created = await executeToolkit<{ id?: string; href?: string }>(paypal.create_invoice!, {
      currency_code: 'EUR',
      note: 'Siren agent live test — will be cancelled',
      primary_recipients: [{ billing_info: { name: { given_name: 'Jay' } } }],
      items: [{ name: 'pizza', quantity: '1', unit_amount: { currency_code: 'EUR', value: '6.00' } }],
    });
    const invoiceId = created.id ?? created.href!.split('/').pop()!;
    createdInvoices.add(invoiceId);
    const { href: payLink } = await executeToolkit<{ href: string }>(paypal.send_invoice!, {
      invoice_id: invoiceId,
      send_to_recipient: false,
    });
    const split = must<{ id: string }>(
      await db
        .from('splits')
        .insert({
          group_id: groupId,
          creator_user_id: damianId,
          description: 'pizza',
          total_amount: 12,
          per_person_amount: 6,
          currency: 'EUR',
          created_at: new Date(Date.now() - 50 * 3_600_000).toISOString(),
        })
        .select('id')
        .single(),
      'insert split',
    );
    const jayMember = must<{ id: string }>(
      await db
        .from('split_members')
        .insert({
          split_id: split.id,
          user_id: jayId,
          display_name: 'Jay',
          status: 'sent',
          reminders_sent: 1,
          last_reminded_at: new Date(Date.now() - 30 * 3_600_000).toISOString(),
          paypal_invoice_id: invoiceId,
          payment_link: payLink,
        })
        .select('id')
        .single(),
      'insert member',
    );
    // The split scenario may have DMed Jay a pay link; only count what happens now.
    const before = sent.length;
    const out = await agent({
      trigger: 'scheduled_run',
      userMessage: '[internal] Split "pizza" has 1 unpaid member, opened 50h ago. Decide what to do.',
      context: { groupId, chatId: FAKE_CHAT_ID, splitId: split.id },
    });
    const dms = sent.slice(before).filter((d) => d.to === JAY_TG);
    const jay = must<{ reminders_sent: number }>(
      await db.from('split_members').select('reminders_sent').eq('id', jayMember.id).single(),
      'read jay',
    );
    check(
      'agent nudged Jay (telegram_dm or PayPal reminder)',
      out.thoughts.some((t) => t.toolCalls.some((c) => c.tool === 'telegram_dm' || c.tool === 'send_invoice_reminder')),
    );
    check('any DM to Jay contains his real pay link', dms.every((d) => d.text.includes(payLink)));
    check('at most one reminder (rate limit)', dms.length <= 1 && jay.reminders_sent <= 2);
    check(
      'no PayPal action on invoices outside this group',
      !out.thoughts.some((t) =>
        t.toolCalls.some((c, i) => {
          const id = (c.input as { invoice_id?: string })?.invoice_id;
          return id !== undefined && !createdInvoices.has(id) && (t.toolResults[i]?.output as { ok?: boolean })?.ok === true;
        }),
      ),
    );
  }

  const logs = must<unknown[]>(await db.from('reasoning_log').select('id').eq('group_id', groupId), 'read log');
  check('every agent run persisted to reasoning_log', logs.length === (scenario === 'all' ? 2 : 1));
} catch (err) {
  console.error(`\nLive run failed: ${safeErrorMessage(err)}`);
  process.exitCode = 1;
} finally {
  // --- clean up: group delete cascades to splits, members, memory, reasoning_log ----
  if (groupId !== undefined) await db.from('groups').delete().eq('id', groupId);
  for (const id of userIds) await db.from('users').delete().eq('id', id);
  for (const id of createdInvoices) {
    await executeToolkit(paypal.cancel_sent_invoice!, {
      invoice_id: id,
      send_to_invoicer: false,
      send_to_recipient: false,
    }).catch((err) => console.error(`Could not cancel ${id}: ${safeErrorMessage(err)}`));
  }
  console.log(`\nCleaned up seeded rows; cancelled ${createdInvoices.size} sandbox invoice(s).`);
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(
    failed === 0 && process.exitCode !== 1 ? `ALL ${checks.length} CHECKS PASSED` : `${failed} CHECK(S) FAILED`,
  );
  if (failed) process.exitCode = 1;
}
