import { asSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import { z as z3 } from 'zod/v3'; // the toolkit builds its schemas with zod 3
import { adaptToolkitTools, getPayPalTools, PAYPAL_TOOL_NAMES, parseToolkitResult } from '../src/paypal/toolkit.js';

// Dummy credentials: the toolkit only authenticates when a tool is executed.
const tools = getPayPalTools({ PAYPAL_CLIENT_ID: 'test-id', PAYPAL_CLIENT_SECRET: 'test-secret' });

describe('PayPal toolkit', () => {
  it('exposes exactly the actions Siren enabled — nothing more', () => {
    expect(Object.keys(tools).sort()).toEqual([...PAYPAL_TOOL_NAMES].sort());
  });

  it('every tool is converted to ai@7 shape (inputSchema + execute)', () => {
    for (const [name, t] of Object.entries(tools)) {
      expect(t.description, name).toBeTruthy();
      expect(t.inputSchema, name).toBeDefined();
      expect(typeof t.execute, name).toBe('function');
    }
  });

  it('ai@7 can turn every toolkit (zod 3) schema into JSON Schema for the LLM', async () => {
    for (const [name, t] of Object.entries(tools)) {
      const json = (await asSchema(t.inputSchema).jsonSchema) as { type?: string };
      expect(json.type, name).toBe('object');
    }
    const create = (await asSchema(tools.create_invoice!.inputSchema).jsonSchema) as { required?: string[] };
    expect(create.required).toEqual(expect.arrayContaining(['currency_code', 'primary_recipients', 'items']));
  });

  it('adapter delegates execution to the toolkit tool', async () => {
    const calls: unknown[] = [];
    const adapted = adaptToolkitTools({
      fake: {
        description: 'fake',
        parameters: z3.object({ x: z3.number() }),
        execute: async (args: unknown) => {
          calls.push(args);
          return '{"ok":true}';
        },
      },
    });
    const out = await adapted.fake!.execute!({ x: 1 }, { toolCallId: 't', messages: [] } as never);
    expect(out).toBe('{"ok":true}');
    expect(calls).toEqual([{ x: 1 }]);
  });
});

describe('parseToolkitResult', () => {
  it('parses a successful JSON string', () => {
    expect(parseToolkitResult('{"id":"INV2-123","status":"DRAFT"}')).toEqual({ id: 'INV2-123', status: 'DRAFT' });
  });

  it('throws on the toolkit {error} shape', () => {
    expect(() => parseToolkitResult('{"error":{"message":"bad input","type":"paypal_error"}}')).toThrow(/bad input/);
  });

  it('throws on the toolkit {ok:false} HTTP error shape', () => {
    expect(() =>
      parseToolkitResult('{"ok":false,"status":403,"code":"PAYPAL_API_HTTP_ERROR","message":"insufficient permissions"}'),
    ).toThrow(/403.*insufficient permissions/);
  });
});
