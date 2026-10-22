// Prompt-cache stats from what production actually recorded: reasoning_log.thoughts holds
// per-step input/cached tokens and the serving model. Usage: npm run cache:report -- [hours=24]
import { usageSummary, type Thought } from '../src/agent/reasoning-log.js';
import { getDb } from '../src/db/client.js';

const hours = Number(process.argv[2] ?? 24);
const since = new Date(Date.now() - hours * 3_600_000).toISOString();
const { data, error } = await getDb().from('reasoning_log').select('thoughts, created_at').gte('created_at', since);
if (error) throw new Error(`read reasoning_log failed: ${error.message}`);

const byModel = new Map<string, Thought[]>();
for (const row of data as { thoughts: Thought[] }[]) {
  for (const t of row.thoughts ?? []) {
    const key = t.model ?? 'unknown';
    byModel.set(key, [...(byModel.get(key) ?? []), t]);
  }
}
console.log(`Agent runs in the last ${hours}h: ${data.length}`);
for (const [model, thoughts] of byModel) {
  const u = usageSummary(thoughts);
  console.log(`  ${model}: ${u.steps} steps, ${u.inputTokens} input tokens, cached ${u.cachedTokens ?? 'not reported'}${u.cacheHitPct !== null ? ` (${u.cacheHitPct}%)` : ''}`);
}
if (byModel.size === 0) console.log('  (no agent steps recorded yet)');
