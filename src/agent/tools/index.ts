import { Api } from 'grammy';
import type { ToolSet } from 'ai';
import type { Config } from '../../config.js';
import { getDb } from '../../db/client.js';
import { createDmStore } from '../../db/split_members.js';
import { createSplitStore } from '../../db/splits.js';
import { getPayPalTools } from '../../paypal/toolkit.js';
import type { AgentContext } from '../types.js';
import { scopePayPalTools } from './paypal_scoped.js';
import { createSendSplitInvoicesTool } from './send_split_invoices.js';
import { createTelegramDmTool, type SendDm } from './telegram_dm.js';

export interface ToolDeps {
  config: Config;
  sendDm?: SendDm;
}

/**
 * Toolkit tools the LLM sees directly. create_invoice/send_invoice are NOT here: their
 * schemas cost ~2,900 tokens per step (Groq free tier: 8k/min). Splits go through the
 * slim send_split_invoices tool + ✅ card instead, which calls them from code.
 */
const AGENT_PAYPAL_TOOLS = ['get_invoice', 'send_invoice_reminder', 'cancel_sent_invoice'];

/** Full tool set for one agent run = scoped PayPal toolkit tools + Siren's custom tools. */
export function getAllTools(context: AgentContext, deps: ToolDeps): ToolSet {
  const api = new Api(deps.config.TELEGRAM_BOT_TOKEN);
  const sendDm: SendDm =
    deps.sendDm ??
    (async (telegramUserId, text) => {
      await api.sendMessage(telegramUserId, text);
    });

  const db = getDb();
  const store = createDmStore(db);
  const scoped = scopePayPalTools(getPayPalTools(deps.config), { context, store });
  const tools: ToolSet = Object.fromEntries(Object.entries(scoped).filter(([name]) => AGENT_PAYPAL_TOOLS.includes(name)));
  tools.telegram_dm = createTelegramDmTool({ context, store, sendDm });
  // Only a real person can start a split (never a scheduled run or webhook).
  if (context.sender) {
    tools.send_split_invoices = createSendSplitInvoicesTool({
      context,
      store: createSplitStore(db),
      senderUserId: context.sender.userId,
    });
  }
  return tools;
}
