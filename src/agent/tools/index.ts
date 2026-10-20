import { Api } from 'grammy';
import type { ToolSet } from 'ai';
import type { Config } from '../../config.js';
import { getDb } from '../../db/client.js';
import { createDmStore } from '../../db/split_members.js';
import { getPayPalTools } from '../../paypal/toolkit.js';
import type { AgentContext } from '../types.js';
import { scopePayPalTools } from './paypal_scoped.js';
import { createTelegramDmTool, type SendDm } from './telegram_dm.js';

export interface ToolDeps {
  config: Config;
  sendDm?: SendDm;
}

/** Full tool set for one agent run = PayPal toolkit tools + Siren's custom tools. */
export function getAllTools(context: AgentContext, deps: ToolDeps): ToolSet {
  const api = new Api(deps.config.TELEGRAM_BOT_TOKEN);
  const sendDm: SendDm =
    deps.sendDm ??
    (async (telegramUserId, text) => {
      await api.sendMessage(telegramUserId, text);
    });

  const store = createDmStore(getDb());
  return {
    ...scopePayPalTools(getPayPalTools(deps.config), { context, store }),
    telegram_dm: createTelegramDmTool({ context, store, sendDm }),
  };
}
