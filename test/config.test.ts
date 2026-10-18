import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

const valid = {
  PAYPAL_CLIENT_ID: 'pp-id',
  PAYPAL_CLIENT_SECRET: 'pp-secret',
  TELEGRAM_BOT_TOKEN: '123:abc',
  GROQ_API_KEY: 'gsk_test',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_KEY: 'service-key',
};

describe('parseConfig', () => {
  it('accepts the minimum required vars and applies defaults', () => {
    const config = parseConfig(valid);
    expect(config.PORT).toBe(3000);
    expect(config.PAYPAL_MODE).toBe('sandbox');
    expect(config.LLM_PROVIDER).toBe('groq');
    expect(config.LLM_MODEL).toBe('openai/gpt-oss-120b');
    expect(config.PUBLIC_URL).toBeUndefined();
  });

  it('treats blank optional vars as unset', () => {
    const config = parseConfig({ ...valid, PAYPAL_WEBHOOK_ID: '', PUBLIC_URL: '  ' });
    expect(config.PAYPAL_WEBHOOK_ID).toBeUndefined();
    expect(config.PUBLIC_URL).toBeUndefined();
  });

  it('lists every missing required var in one error', () => {
    const { TELEGRAM_BOT_TOKEN: _t, GROQ_API_KEY: _g, ...rest } = valid;
    let msg = '';
    try {
      parseConfig({ ...rest, SUPABASE_SERVICE_KEY: '' });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('TELEGRAM_BOT_TOKEN');
    expect(msg).toContain('GROQ_API_KEY');
    expect(msg).toContain('SUPABASE_SERVICE_KEY');
    expect(msg).toContain('.env.local');
  });

  it('rejects live PayPal mode (sandbox only)', () => {
    expect(() => parseConfig({ ...valid, PAYPAL_MODE: 'live' })).toThrowError(/PAYPAL_MODE/);
  });

  it('rejects a malformed SUPABASE_URL', () => {
    expect(() => parseConfig({ ...valid, SUPABASE_URL: 'not-a-url' })).toThrowError(/SUPABASE_URL/);
  });

  it('coerces PORT from string', () => {
    expect(parseConfig({ ...valid, PORT: '8080' }).PORT).toBe(8080);
  });
});
