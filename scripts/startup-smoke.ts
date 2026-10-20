// Real-startup smoke test: boots `src/server.ts` exactly as `npm start` would (real
// .env.local, real Telegram long polling, real Supabase client), keeps it up for N
// seconds, then checks it is still alive and /health answers. Catches crashes that
// app.inject() tests can't see, e.g. the milestone-4 grammy webhook/polling crash ~10s
// after boot. Usage: npm run test:startup [-- seconds]   (default 15)
//
// Note: uses the real bot token, so it fails with a 409 if another instance
// (e.g. the Render deploy in webhook mode, or `npm run dev`) is already polling.
import { spawn } from 'node:child_process';

const seconds = Number(process.argv[2] ?? 15);
const port = 3999; // avoid clashing with a dev server on 3000

const child = spawn('npx', ['tsx', 'src/server.ts'], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

// Keep only the last lines of output, shown if the test fails.
const tail: string[] = [];
const collect = (chunk: Buffer) => {
  tail.push(...chunk.toString().split('\n').filter(Boolean));
  tail.splice(0, Math.max(0, tail.length - 15));
};
child.stdout.on('data', collect);
child.stderr.on('data', collect);

let exitCode: number | null | undefined;
child.on('exit', (code) => (exitCode = code));

function fail(reason: string): never {
  console.error(`✗ startup smoke test failed: ${reason}\n--- last server output ---\n${tail.join('\n')}`);
  if (exitCode === undefined) child.kill('SIGTERM');
  process.exit(1);
}

console.log(`Booting real server on :${port} for ${seconds}s ...`);
await new Promise((r) => setTimeout(r, seconds * 1000));

if (exitCode !== undefined) fail(`server exited early with code ${exitCode}`);

const res = await fetch(`http://127.0.0.1:${port}/health`).catch((err: Error) => fail(`/health unreachable: ${err.message}`));
if (!res.ok) fail(`/health returned ${res.status}`);

child.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 3000));
if (exitCode === undefined) fail('server did not shut down within 3s of SIGTERM');
if (exitCode !== 0) fail(`server exited with code ${exitCode} on SIGTERM`);

console.log(`✓ server stayed up ${seconds}s, /health ok, clean shutdown`);
