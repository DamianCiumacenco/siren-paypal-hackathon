const SYMBOL: Record<string, string> = { EUR: '€', GBP: '£', USD: '$' };

/** "€6.00" / "£4.50" / "$10.00" — the one format people see for amounts (DMs, /status). */
export function money(amount: number, currency: string): string {
  const sym = SYMBOL[currency];
  return sym ? `${sym}${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency}`;
}
