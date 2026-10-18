import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadConfig } from '../config.js';

let client: SupabaseClient | undefined;

/** Server-side Supabase client using the service_role key (bypasses RLS — never expose to a browser). */
export function getDb(): SupabaseClient {
  if (!client) {
    const config = loadConfig();
    client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

export const TABLES = ['groups', 'users', 'splits', 'split_members', 'user_memory', 'reasoning_log'] as const;
