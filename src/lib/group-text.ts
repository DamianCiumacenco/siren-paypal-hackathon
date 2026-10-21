/**
 * Every agent-written message posted in a GROUP goes through toGroupText(). Prompt rules
 * ask the model not to show internal ids or pay links in the group, but it occasionally
 * does anyway (seen in milestone 8–10 live runs), so this enforces it in code:
 * - Markdown stripped (we send plain text; Telegram would show ** and # literally)
 * - pay links → "[pay link sent by DM]" (links belong in private DMs)
 * - invoice numbers, uuids and "user_id N"-style labels removed
 */
export function plainText(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .trim();
}

export function toGroupText(text: string): string {
  return plainText(text)
    .replace(/https?:\/\/(www\.)?(sandbox\.)?paypal\.com\/invoice\/\S+/gi, '[pay link sent by DM]')
    .replace(/\bINV2-[A-Z0-9-]+/g, '')
    .replace(/\s*[([]?\b(split_member_id|user_id|split_id|invoice_id|user)\s*[:=#]?\s*[0-9a-f-]*\d[0-9a-f-]*[)\]]?/gi, '')
    .replace(/\s*[([]?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[)\]]?/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
