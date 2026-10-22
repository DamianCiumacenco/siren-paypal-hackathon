// Live agent check: real Groq model, real PayPal toolkit (sandbox), real Supabase, against a
// throwaway group that is deleted at the end (every invoice it created is cancelled).
//
//   npm run agent:live                      # both scenarios, DMs are dry runs (printed, not sent)
//   npm run agent:live -- --scenario split  # split | nag | memory | tones | payment | scheduler | cache
//   npm run agent:live -- --dm <telegramId> # really DM that Telegram user (must have /start-ed the bot)
//   npm run agent:live -- --only gemini     # run the agent on one provider (groq | gemini | nvidia)
//   npm run agent:live -- --switch-after 1  # bench Groq after N LLM calls (simulates its daily cap mid-run)
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
import { insertReasoningLog, lastReasoningLog } from '../src/db/reasoning_log.js';
import { usageSummary, type Thought } from '../src/agent/reasoning-log.js';
import { createMemoryStore } from '../src/db/memory.js';
import { createPaymentStore } from '../src/db/payments.js';
import { createInvoiceStore } from '../src/db/split_members.js';
import { formatWhy } from '../src/bot/handlers/why.js';
import { toGroupText } from '../src/lib/group-text.js';
import { handleInvoicePaid } from '../src/memory/on-payment.js';
import { dispatchWebhookEvent } from '../src/paypal/webhooks.js';
import { createSchedulerStore } from '../src/db/scheduler.js';
import { ChatLock } from '../src/lib/chat-lock.js';
import { runScheduledPass } from '../src/scheduler/runner.js';
import { createSplitStore } from '../src/db/splits.js';
import { safeErrorMessage, type Logger } from '../src/lib/safe-error.js';
import { FailoverModel } from '../src/llm/failover.js';
import { providerSlots } from '../src/llm/providers.js';
import { LongRateLimitError } from '../src/llm/rate-limit.js';
import { formatSendSummary, sendSplitInvoices } from '../src/paypal/split_invoices.js';
import { executeToolkit, getPayPalTools } from '../src/paypal/toolkit.js';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const scenario = arg('scenario') ?? 'all';
const realDmTarget = arg('dm') ? Number(arg('dm')) : undefined;

const config = loadConfig();

// The agent's model: the real failover chain, optionally narrowed (--only) or with Groq's
// daily cap simulated after N calls (--switch-after), to prove each fallback live.
const only = arg('only');
const switchAfter = arg('switch-after') ? Number(arg('switch-after')) : undefined;
let groqCalls = 0;
const slots = providerSlots(config)
  .filter((s) => !only || s.name === only)
  .map((s) =>
    s.name !== 'groq' || switchAfter === undefined
      ? s
      : {
          ...s,
          model: {
            ...s.model,
            specificationVersion: 'v4' as const,
            provider: s.model.provider,
            modelId: s.model.modelId,
            supportedUrls: s.model.supportedUrls,
            doGenerate: (o: Parameters<typeof s.model.doGenerate>[0]) => {
              if (++groqCalls > switchAfter) throw new LongRateLimitError(8 * 60_000, 'groq');
              return s.model.doGenerate(o);
            },
            doStream: s.model.doStream.bind(s.model),
          },
        },
  );
if (slots.length === 0) throw new Error(`--only ${only}: provider not configured`);
const llm = new FailoverModel(slots, {
  info: (o, m) => console.log(`  [llm] ${m} ${JSON.stringify(o)}`),
  warn: (o, m) => console.log(`  [llm] ${m} ${JSON.stringify(o)}`),
  error: (o, m) => console.log(`  [llm] ${m} ${JSON.stringify(o)}`),
});
console.log(`LLM chain: ${slots.map((s) => s.name).join(' → ')}${switchAfter !== undefined ? ` (Groq benched after ${switchAfter} call(s))` : ''}`);
const db = getDb();
const paypal = getPayPalTools(config);
const splits = createSplitStore(db);
const log: Logger = { info: () => {}, warn: (o, m) => console.warn(m, o), error: (o, m) => console.error(m, o) };

// Fake ids well outside real Telegram ranges so they can't collide with real rows.
const rand = () => Math.floor(Math.random() * 100_000);
const FAKE_CHAT_ID = -1009999000000 - rand();
const DAMIAN_TG = 999_100_000 + rand();
const JAY_TG = realDmTarget ?? 999_200_000 + rand();
const SEAN_TG = 999_300_000 + rand();

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
const allThoughts: Thought[] = [];
const checks: [string, boolean][] = [];
const check = (name: string, ok: boolean) => {
  checks.push([name, ok]);
  console.log(`${ok ? '✓' : '✗'} ${name}`);
};

function printRun(out: AgentOutput, seconds: number) {
  console.log(`Agent finished in ${seconds.toFixed(1)}s, ${out.thoughts.length} step(s)`);
  for (const t of out.thoughts) {
    const cached = t.tokens.cached === undefined ? 'cache: not reported' : `${t.tokens.cached} cached`;
    console.log(`  step ${t.step} [${t.model ?? '?'}] (${t.tokens.input ?? '?'} in / ${t.tokens.output ?? '?'} out tokens, ${cached})`);
    for (const c of t.toolCalls) console.log(`    → ${c.tool} ${JSON.stringify(c.input)}`);
    for (const r of t.toolResults) console.log(`    ← ${r.tool} ${JSON.stringify(r.output).slice(0, 220)}`);
    for (const e of t.toolErrors) console.log(`    ✗ ${e.tool} ${e.error}`);
  }
  console.log(`  Group reply: ${out.response}\n`);
}

/**
 * In a full run every scenario shares group A. Real splits each get a fresh context, so
 * close the previous scenario's open splits before the next one starts — otherwise later
 * scenarios see 3–4 unrelated open splits and the agent's choices drift.
 */
async function freshGroup() {
  if (groupId !== undefined) await db.from('splits').update({ status: 'settled' }).eq('group_id', groupId).eq('status', 'open');
}

async function agent(input: AgentInput) {
  const started = Date.now();
  const out = await runAgent(input, {
    model: llm,
    tools: getAllTools(input.context, { config, sendDm }),
    groupContext: await loadGroupContext(db, input.context.groupId),
    persist: (r) => insertReasoningLog(db, r),
  });
  printRun(out, (Date.now() - started) / 1000);
  allThoughts.push(...out.thoughts);
  return out;
}

let groupId: number | undefined;
let groupB: number | undefined;
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
    [SEAN_TG, 'Sean', 'chill', 0.94],
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
  const [damianId, jayId, seanId] = userIds as [number, number, number];
  console.log(`Seeded group ${groupId}: Damian (sender), Jay (direct, 0.3), Sean (chill, 0.94)\n`);

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
    await freshGroup();
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
    const decision = out.thoughts.flatMap((t) => t.toolCalls.map((c) => c.tool)).filter((t) => t !== 'get_member_profile' && t !== 'fetch_group_history');
    console.log(`  (decision) tools used: ${decision.join(', ') || 'none'} | ${out.thoughts.map((t) => t.model).join(' > ')}`);
    // Nudging is expected for an overdue, unreliable member; deliberately deferring with
    // schedule_followup is also a legitimate autonomous decision. Doing nothing is not.
    check(
      'agent decided: nudged Jay, or deliberately scheduled a follow-up',
      decision.some((t) => t === 'telegram_dm' || t === 'send_invoice_reminder' || t === 'schedule_followup'),
    );
    check('any DM to Jay contains his real pay link', dms.every((d) => d.text.includes(payLink)));
    check("group reply doesn't repeat the DM or expose Jay's pay link", !out.response.includes(payLink) && !dms.some((d) => out.response.includes(d.text)));
    const followup = out.thoughts.some((t) => t.toolCalls.some((c) => c.tool === 'schedule_followup'));
    console.log(`  (info) schedule_followup used: ${followup}`);
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

  // --- scenario: memory (/siren about, tone, debt) ---------------------------------
  let memoryRuns = 0;
  if (scenario === 'all' || scenario === 'memory') {
    if (scenario === 'all') {
      console.log('\n(waiting 60s for the Groq tokens-per-minute window)\n');
      await new Promise((r) => setTimeout(r, 60_000));
    }
    await freshGroup();
    // Jay: a reliable payer with history, so "about" has something real to say.
    await db
      .from('user_memory')
      .update({ reliability_score: 0.94, preferred_tone: 'chill', avg_hours_to_pay: 6, total_splits: 17, total_paid_ontime: 16, notes: '2026-10-01: gets paid on the 25th' })
      .eq('user_id', jayId)
      .eq('group_id', groupId);
    const past = must<{ id: string }>(
      await db
        .from('splits')
        .insert({ group_id: groupId, creator_user_id: damianId, description: 'bowling', total_amount: 20, per_person_amount: 10, currency: 'EUR', status: 'settled', created_at: '2026-10-10T18:00:00Z' })
        .select('id')
        .single(),
      'insert past split',
    );
    await db.from('split_members').insert({ split_id: past.id, user_id: jayId, display_name: 'Jay', status: 'paid', paid_at: '2026-10-11T00:00:00Z' });
    const open = must<{ id: string }>(
      await db
        .from('splits')
        .insert({ group_id: groupId, creator_user_id: damianId, description: 'cinema', total_amount: 24, per_person_amount: 12, currency: 'EUR', status: 'open' })
        .select('id')
        .single(),
      'insert open split',
    );
    await db.from('split_members').insert({ split_id: open.id, user_id: jayId, display_name: 'Jay', status: 'sent' });
    const sender = { telegramUserId: DAMIAN_TG, firstName: 'Damian', userId: damianId };
    const used = (out: AgentOutput, tool: string) => out.thoughts.some((t) => t.toolCalls.some((c) => c.tool === tool));

    console.log('=== memory: /siren about Jay');
    const about = await agent({ trigger: 'user_message', userMessage: '/siren about Jay', context: { groupId, chatId: FAKE_CHAT_ID, sender } });
    memoryRuns++;
    check('about: used get_member_profile', used(about, 'get_member_profile'));
    check('about: reply cites the learned profile (0.94 / 94% / 25th)', /0\.94|94\s?%|25th/.test(about.response));
    console.log(`  full about reply:\n${about.response.split('\n').map((l) => `  | ${l}`).join('\n')}`);
    // What the group actually sees is the sanitised text (toGroupText), not the raw model output.
    check('about: no internal ids in what the group sees', !/user[ _]?(id)?\s*:?\s*\d|split_member_id|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(toGroupText(about.response)));
    await new Promise((r) => setTimeout(r, 25_000));

    console.log('=== memory: /siren tone direct (from Damian)');
    const tone = await agent({ trigger: 'user_message', userMessage: '/siren tone direct', context: { groupId, chatId: FAKE_CHAT_ID, sender } });
    memoryRuns++;
    const damianTone = must<{ preferred_tone: string }>(
      await db.from('user_memory').select('preferred_tone').eq('user_id', damianId).eq('group_id', groupId).single(),
      'read tone',
    );
    const jayTone = must<{ preferred_tone: string }>(
      await db.from('user_memory').select('preferred_tone').eq('user_id', jayId).eq('group_id', groupId).single(),
      'read jay tone',
    );
    check('tone: remember_preference set the SENDER to direct', used(tone, 'remember_preference') && damianTone.preferred_tone === 'direct');
    check("tone: Jay's tone untouched", jayTone.preferred_tone === 'chill');
    await new Promise((r) => setTimeout(r, 25_000));

    console.log('=== memory: /siren debt');
    const debt = await agent({ trigger: 'user_message', userMessage: '/siren debt', context: { groupId, chatId: FAKE_CHAT_ID, sender } });
    memoryRuns++;
    check('debt: used summarise_debt', used(debt, 'summarise_debt'));
    // Open splits at this point: cinema (Jay €12) + whatever earlier scenarios left open.
    const expected = must<{ debts: { from: string; amount: string }[] }>(
      { data: debt.thoughts.flatMap((t) => t.toolResults).find((r) => r.tool === 'summarise_debt')?.output ?? null, error: null },
      'read debt result',
    ).debts.find((d) => d.from === 'Jay');
    check('debt: reply quotes the tool\'s figure for Jay', expected !== undefined && debt.response.includes(expected.amount.split(' ')[0]!));
  }

  // --- scenario: tones (success criterion 7) + /siren why (criterion 5) ------------
  let tonesRuns = 0;
  if (scenario === 'all' || scenario === 'tones') {
    if (scenario === 'all') {
      console.log('\n(waiting 60s for the Groq tokens-per-minute window)\n');
      await new Promise((r) => setTimeout(r, 60_000));
    }
    await freshGroup();
    console.log('=== tones: scheduled run, Jay (direct, 0.3) and Sean (chill, 0.94) both unpaid 50h');
    // Earlier scenarios (memory) change Jay's profile; reset both so the tones differ by design.
    await db.from('user_memory').update({ reliability_score: 0.3, preferred_tone: 'direct', avg_hours_to_pay: 90, notes: null }).eq('user_id', jayId).eq('group_id', groupId);
    await db.from('user_memory').update({ reliability_score: 0.94, preferred_tone: 'chill', avg_hours_to_pay: 5, notes: null }).eq('user_id', seanId).eq('group_id', groupId);
    // Earlier scenarios in this run may have reminded Jay minutes ago; the real 24h limit
    // (enforced in the tools) would then correctly refuse. Simulate a day passing.
    const dayAgo = new Date(Date.now() - 30 * 3_600_000).toISOString();
    for (const uid of [jayId, seanId]) {
      await db.from('split_members').update({ last_reminded_at: dayAgo }).eq('user_id', uid).not('last_reminded_at', 'is', null);
    }
    const split = must<{ id: string }>(
      await db
        .from('splits')
        .insert({ group_id: groupId, creator_user_id: damianId, description: 'golf', total_amount: 30, per_person_amount: 10, currency: 'EUR', status: 'open', created_at: new Date(Date.now() - 50 * 3_600_000).toISOString() })
        .select('id')
        .single(),
      'insert golf split',
    );
    const links: Record<string, string> = {};
    for (const [uid, name] of [[jayId, 'Jay'], [seanId, 'Sean']] as const) {
      const created = await executeToolkit<{ id?: string; href?: string }>(paypal.create_invoice!, {
        currency_code: 'EUR',
        note: 'Siren agent live test — will be cancelled',
        primary_recipients: [{ billing_info: { name: { given_name: name } } }],
        items: [{ name: 'golf', quantity: '1', unit_amount: { currency_code: 'EUR', value: '10.00' } }],
      });
      const inv = created.id ?? created.href!.split('/').pop()!;
      createdInvoices.add(inv);
      links[name] = (await executeToolkit<{ href: string }>(paypal.send_invoice!, { invoice_id: inv, send_to_recipient: false })).href;
      await db.from('split_members').insert({
        split_id: split.id, user_id: uid, display_name: name, status: 'sent', reminders_sent: 0,
        last_reminded_at: new Date(Date.now() - 30 * 3_600_000).toISOString(), paypal_invoice_id: inv, payment_link: links[name],
      });
    }
    const before = sent.length;
    const out = await agent({
      trigger: 'scheduled_run',
      userMessage: '[internal] Split "golf" has 2 unpaid members, opened 50h ago. Decide what to do.',
      context: { groupId, chatId: FAKE_CHAT_ID, splitId: split.id },
    });
    tonesRuns++;
    const jayDm = sent.slice(before).find((d) => d.to === JAY_TG)?.text;
    const seanDm = sent.slice(before).find((d) => d.to === SEAN_TG)?.text;
    console.log(`  Jay DM:  ${jayDm ?? '(none)'}\n  Sean DM: ${seanDm ?? '(none)'}\n`);
    check('tones: both Jay and Sean were DMed', jayDm !== undefined && seanDm !== undefined);
    check('tones: each DM has that person\'s own pay link', Boolean(jayDm?.includes(links.Jay!) && seanDm?.includes(links.Sean!)));
    check('tones: both DMs state the exact share (€10.00), never another amount', [jayDm, seanDm].every((d) => d !== undefined && d.includes('€10.00') && !/€(?!10\.00)\d/.test(d)));
    // Compare with names and links removed, so "Hey Jay" vs "Hey Sean" alone doesn't count.
    const core = (t: string | undefined, name: string, link: string) => (t ?? '').replace(link, '').replace(new RegExp(name, 'gi'), '').replace(/\W+/g, ' ').trim().toLowerCase();
    check('tones: different wording for direct Jay vs chill Sean (names/links removed)', jayDm !== undefined && seanDm !== undefined && core(jayDm, 'Jay', links.Jay!) !== core(seanDm, 'Sean', links.Sean!));
    check('tones: the direct reminder is not the chill "no rush" one', !/no rush|when you get a sec/i.test(jayDm ?? 'no rush'));

    console.log('=== /siren why (from reasoning_log, no LLM)');
    const why = formatWhy(await lastReasoningLog(db, groupId));
    console.log(why.split('\n').map((l) => `  | ${l}`).join('\n'));
    check('why: shows real steps with tool calls', /Step 1/.test(why) && /→ telegram_dm/.test(why));
    check('why: no pay links, DM wording, invoice numbers or ids', !/https?:|INV2-|[0-9a-f]{8}-[0-9a-f]{4}-|user_id/.test(why) && !why.includes(jayDm?.slice(0, 20) ?? '∅'));
  }

  // --- scenario: payment webhook → memory → settle → group post (no LLM) -----------
  if (scenario === 'all' || scenario === 'payment') {
    console.log('=== payment: INVOICING.INVOICE.PAID for Jay, then Sean (real DB, deterministic)');
    const split = must<{ id: string }>(
      await db
        .from('splits')
        .insert({ group_id: groupId, creator_user_id: damianId, description: 'darts', total_amount: 24, per_person_amount: 8, currency: 'EUR', status: 'open', created_at: new Date(Date.now() - 5 * 3_600_000).toISOString() })
        .select('id')
        .single(),
      'insert darts split',
    );
    const fakeInv = (n: string) => `INV2-LIVE-${n}-${rand()}`;
    const jayInv = fakeInv('JAY');
    const seanInv = fakeInv('SEAN');
    await db.from('split_members').insert([
      { split_id: split.id, user_id: jayId, display_name: 'Jay', status: 'sent', paypal_invoice_id: jayInv },
      { split_id: split.id, user_id: seanId, display_name: 'Sean', status: 'sent', paypal_invoice_id: seanInv },
    ]);
    const invoices = createInvoiceStore(db);
    const posts: string[] = [];
    const onPaid = (inv: string) =>
      handleInvoicePaid(inv, { payments: createPaymentStore(db), memory: createMemoryStore(db), postToGroup: async (_c, t) => void posts.push(t) });
    // Same logic as routes/paypal.ts: the hook runs only on the delivery that marked it paid.
    const deliver = async (inv: string) => {
      const r = await dispatchWebhookEvent({ id: `WH-${rand()}`, event_type: 'INVOICING.INVOICE.PAID', create_time: new Date().toISOString(), resource: { invoice: { id: inv } } }, invoices);
      if (r.handled && r.updated > 0) await onPaid(inv);
      return r;
    };
    await deliver(jayInv);
    const jayMem = must<{ reliability_score: unknown; total_splits: number; preferred_tone: string }>(
      await db.from('user_memory').select('reliability_score, total_splits, preferred_tone').eq('user_id', jayId).eq('group_id', groupId).single(),
      'read jay memory',
    );
    console.log(`  posts: ${JSON.stringify(posts)}\n  Jay memory after paying in ~5h: ${JSON.stringify(jayMem)}`);
    check('payment: Jay marked paid and the group told "1/2 paid"', posts[0]?.includes('Jay paid 8.00 EUR for "darts" — 1/2 paid.') === true);
    check('payment: Jay\'s memory recomputed from his record', jayMem.reliability_score !== null && jayMem.total_splits >= 1);
    const retry = await deliver(jayInv);
    check('payment: PayPal retry of the same event changes nothing', retry.handled && retry.updated === 0 && posts.length === 1);
    await deliver(seanInv);
    const settled = must<{ status: string }>(await db.from('splits').select('status').eq('id', split.id).single(), 'read split');
    check('payment: last payment settles the split + 🎉 post', settled.status === 'settled' && posts[1]?.includes('is settled') === true);
  }

  // --- scenario: scheduler (Flow C, fired manually) --------------------------------
  let schedulerRuns = 0;
  if (scenario === 'all' || scenario === 'scheduler') {
    if (scenario === 'all') {
      console.log('\n(waiting 60s for the LLM tokens-per-minute window)\n');
      await new Promise((r) => setTimeout(r, 60_000));
    }
    await freshGroup();
    console.log('=== scheduler: two groups, pass fired manually');
    // Earlier scenarios in a full run reminded Jay/Sean minutes ago; the real per-user 24h
    // cap would then (correctly) refuse. Simulate a day passing, as the tones scenario does.
    for (const uid of [jayId, seanId]) {
      await db.from('split_members').update({ last_reminded_at: new Date(Date.now() - 30 * 3_600_000).toISOString() }).eq('user_id', uid).not('last_reminded_at', 'is', null);
    }
    const schedulerStartedAt = new Date().toISOString();
    // Group A (the seeded group): golf, 50h old — Jay never reminded, Sean reminded 2h ago.
    await db.from('user_memory').update({ reliability_score: 0.3, preferred_tone: 'direct', tone_locked: true }).eq('user_id', jayId).eq('group_id', groupId);
    await db.from('user_memory').update({ reliability_score: 0.94, preferred_tone: 'chill', tone_locked: true }).eq('user_id', seanId).eq('group_id', groupId);
    const golf = must<{ id: string }>(
      await db.from('splits').insert({ group_id: groupId, creator_user_id: damianId, description: 'sched golf', total_amount: 30, per_person_amount: 10, currency: 'EUR', status: 'open', created_at: new Date(Date.now() - 50 * 3_600_000).toISOString() }).select('id').single(),
      'insert sched split',
    );
    const invoiceFor = async (name: string) => {
      const c = await executeToolkit<{ id?: string; href?: string }>(paypal.create_invoice!, {
        currency_code: 'EUR', note: 'Siren agent live test — will be cancelled',
        primary_recipients: [{ billing_info: { name: { given_name: name } } }],
        items: [{ name: 'sched', quantity: '1', unit_amount: { currency_code: 'EUR', value: '10.00' } }],
      });
      const inv = c.id ?? c.href!.split('/').pop()!;
      createdInvoices.add(inv);
      return { inv, link: (await executeToolkit<{ href: string }>(paypal.send_invoice!, { invoice_id: inv, send_to_recipient: false })).href };
    };
    const jayInv = await invoiceFor('Jay');
    const seanInv = await invoiceFor('Sean');
    await db.from('split_members').insert([
      { split_id: golf.id, user_id: jayId, display_name: 'Jay', status: 'sent', paypal_invoice_id: jayInv.inv, payment_link: jayInv.link },
      { split_id: golf.id, user_id: seanId, display_name: 'Sean', status: 'sent', reminders_sent: 1, last_reminded_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), paypal_invoice_id: seanInv.inv, payment_link: seanInv.link },
    ]);
    // Group A, second split: the agent already scheduled a follow-up for later → must be skipped.
    const later = must<{ id: string }>(
      await db.from('splits').insert({ group_id: groupId, creator_user_id: damianId, description: 'sched later', total_amount: 10, per_person_amount: 5, currency: 'EUR', status: 'open', next_nag_at: new Date(Date.now() + 5 * 3_600_000).toISOString() }).select('id').single(),
      'insert later split',
    );
    await db.from('split_members').insert({ split_id: later.id, user_id: jayId, display_name: 'Jay', status: 'sent' });
    // Group B: Mike owes there. A's run must never touch him; B's run must never touch Jay/Sean.
    groupB = must<{ id: number }>(await db.from('groups').insert({ telegram_chat_id: FAKE_CHAT_ID - 1, chat_title: 'Siren live test B' }).select('id').single(), 'insert group B').id;
    const MIKE_TG = 999_400_000 + rand();
    const mikeId = must<{ id: number }>(await db.from('users').insert({ telegram_user_id: MIKE_TG, first_name: 'Mike' }).select('id').single(), 'insert Mike').id;
    userIds.push(mikeId);
    await db.from('user_memory').insert({ user_id: mikeId, group_id: groupB, reliability_score: 0.6, preferred_tone: 'neutral' });
    const mikeInv = await invoiceFor('Mike');
    const bSplit = must<{ id: string }>(
      await db.from('splits').insert({ group_id: groupB, creator_user_id: mikeId, description: 'sched bowling', total_amount: 20, per_person_amount: 10, currency: 'EUR', status: 'open', created_at: new Date(Date.now() - 80 * 3_600_000).toISOString() }).select('id').single(),
      'insert B split',
    );
    await db.from('split_members').insert({ split_id: bSplit.id, user_id: mikeId, display_name: 'Mike', status: 'sent', paypal_invoice_id: mikeInv.inv, payment_link: mikeInv.link });

    const posts: { chat: number; text: string }[] = [];
    const dmsByRun: { group: number; to: number[] }[] = [];
    const schedulerDeps = {
      store: createSchedulerStore(db),
      memory: createMemoryStore(db),
      runAgent: async (input: AgentInput) => {
        const before = sent.length;
        const out = await agent(input);
        dmsByRun.push({ group: input.context.groupId, to: sent.slice(before).map((d) => d.to) });
        if (input.context.groupId === groupId) schedulerRuns++;
        return out;
      },
      postToGroup: async (chat: number, text: string) => void posts.push({ chat, text }),
      lock: new ChatLock(),
      log,
      groupIds: [groupId, groupB],
    };

    console.log('--- pass 1');
    const sentBefore = sent.length;
    const pass1 = await runScheduledPass(schedulerDeps);
    console.log(`  pass 1: ${JSON.stringify(pass1)}`);
    for (const p of posts) console.log(`  group post → ${p.chat === FAKE_CHAT_ID ? 'A' : 'B'}: ${p.text.replace(/\n/g, ' | ')}`);
    const dms = sent.slice(sentBefore);
    check('scheduler: agent ran for the 2 eligible splits, skipped the scheduled follow-up (no LLM)', pass1.agentRuns === 2 && pass1.skipped.followup_scheduled === 1);
    check('scheduler: autonomously reminded Jay (overdue, never reminded)', dms.some((d) => d.to === JAY_TG));
    check('scheduler: Sean NOT reminded (reminded 2h ago — 24h cap)', !dms.some((d) => d.to === SEAN_TG));
    check("scheduler: group isolation — A's run only DMed A members, B's only B's", dmsByRun.every((r) => r.to.every((to) => (r.group === groupB ? to === MIKE_TG : to !== MIKE_TG))));
    check('scheduler: Mike reminded by group B\'s run', dmsByRun.some((r) => r.group === groupB && r.to.includes(MIKE_TG)));
    const triggers = must<{ trigger: string }[]>(
      await db.from('reasoning_log').select('trigger').in('group_id', [groupId, groupB]).eq('trigger', 'scheduled_run').gte('created_at', schedulerStartedAt),
      'read triggers',
    );
    check("scheduler: both runs logged with trigger 'scheduled_run'", triggers.length === 2);
    check('scheduler: group posts are sanitised (no pay links / ids)', posts.length > 0 && posts.every((p) => !/https?:|INV2-|[0-9a-f]{8}-[0-9a-f]{4}-/.test(p.text)));
    const whyA = formatWhy(await lastReasoningLog(db, groupId));
    console.log(whyA.split('\n').slice(0, 4).map((l) => `  | ${l}`).join('\n'));
    check('scheduler: /siren why says it was a scheduled check (autonomous)', whyA.startsWith('My last decision (scheduled check'));

    console.log('--- pass 2 (immediately after)');
    const pass2 = await runScheduledPass(schedulerDeps);
    console.log(`  pass 2: ${JSON.stringify(pass2)}`);
    check('scheduler: pass 2 makes zero LLM calls (everyone reminded <24h / follow-up pending)', pass2.agentRuns === 0 && sent.length === sentBefore + dms.length);
  }

  // --- scenario: cache (milestone 12) — does the stable prefix get reused? ------------
  let cacheRuns = 0;
  if (scenario === 'cache') {
    console.log('=== cache: same group, two different questions back to back, per provider');
    const sender = { telegramUserId: DAMIAN_TG, firstName: 'Damian', userId: damianId };
    for (const slot of slots) {
      const single = new FailoverModel([slot], log);
      for (const q of ['/siren debt', '/status']) {
        const before = Date.now();
        const out = await runAgent(
          { trigger: 'user_message', userMessage: q, context: { groupId, chatId: FAKE_CHAT_ID, sender } },
          { model: single, tools: getAllTools({ groupId, chatId: FAKE_CHAT_ID, sender }, { config, sendDm }), groupContext: await loadGroupContext(db, groupId), persist: (r) => insertReasoningLog(db, r) },
        ).catch((e: unknown) => { console.log(`  ${slot.name}: ${safeErrorMessage(e)}`); return undefined; });
        if (!out) break;
        cacheRuns++;
        const u = usageSummary(out.thoughts);
        console.log(`  ${slot.name} ${q}: ${((Date.now() - before) / 1000).toFixed(1)}s, ${u.inputTokens} in, cached ${u.cachedTokens ?? 'not reported'}${u.cacheHitPct !== null ? ` (${u.cacheHitPct}%)` : ''}`);
        allThoughts.push(...out.thoughts);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    check('cache: token + cache telemetry recorded for every step', allThoughts.length > 0 && allThoughts.every((t) => t.tokens.input !== undefined));
  }

  const logs = must<unknown[]>(await db.from('reasoning_log').select('id').eq('group_id', groupId), 'read log');
  const expectedRuns =
    (scenario === 'all' ? 2 : scenario === 'split' || scenario === 'nag' ? 1 : 0) + memoryRuns + tonesRuns + schedulerRuns + cacheRuns;
  check('every agent run persisted to reasoning_log', logs.length === expectedRuns);
} catch (err) {
  console.error(`\nLive run failed: ${safeErrorMessage(err)}`);
  process.exitCode = 1;
} finally {
  // --- clean up: group delete cascades to splits, members, memory, reasoning_log ----
  if (groupId !== undefined) await db.from('groups').delete().eq('id', groupId);
  if (groupB !== undefined) await db.from('groups').delete().eq('id', groupB);
  for (const id of userIds) await db.from('users').delete().eq('id', id);
  for (const id of createdInvoices) {
    await executeToolkit(paypal.cancel_sent_invoice!, {
      invoice_id: id,
      send_to_invoicer: false,
      send_to_recipient: false,
    }).catch((err) => console.error(`Could not cancel ${id}: ${safeErrorMessage(err)}`));
  }
  console.log(`\nCleaned up seeded rows; cancelled ${createdInvoices.size} sandbox invoice(s).`);
  if (allThoughts.length) console.log(`Prompt cache over this run: ${JSON.stringify(usageSummary(allThoughts))}`);
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(
    failed === 0 && process.exitCode !== 1 ? `ALL ${checks.length} CHECKS PASSED` : `${failed} CHECK(S) FAILED`,
  );
  if (failed) process.exitCode = 1;
}
