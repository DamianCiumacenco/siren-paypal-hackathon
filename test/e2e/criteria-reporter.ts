import type { Reporter, TestModule } from 'vitest/node';

/**
 * Prints one PASS/FAIL line per SCOPE criterion at the end of `npm run test:e2e`.
 * A skipped or empty criterion counts as FAIL: "no silent skips".
 */
export default class CriteriaReporter implements Reporter {
  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    const rows = modules.map((m) => {
      const file = m.moduleId.split('/').pop()!;
      const n = /^criterion-(\d+)-/.exec(file)?.[1];
      const tests = [...m.children.allTests()];
      const passed = tests.filter((t) => t.result().state === 'passed').length;
      const ok = m.state() === 'passed' && tests.length > 0 && passed === tests.length;
      return { n: n ? Number(n) : 99, line: `${ok ? 'PASS' : 'FAIL'}  ${n ? `criterion ${n}` : 'extra      '}  ${file}  (${passed}/${tests.length} tests)` };
    });
    rows.sort((a, b) => a.n - b.n);
    console.log(`\n=== SCOPE success criteria (live) ===\n${rows.map((r) => r.line).join('\n')}`);
    const missing = [1, 2, 3, 4, 5, 6, 7].filter((n) => !rows.some((r) => r.n === n));
    if (missing.length) console.log(`FAIL  not run: criterion ${missing.join(', ')}`);
  }
}
