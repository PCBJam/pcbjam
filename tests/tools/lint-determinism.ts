/**
 * Determinism guard for the e2e/kicad specs. Fails (exit 1) if a spec reintroduces a banned
 * anti-pattern, so the flake we removed can't creep back. Run locally or in CI:
 *
 *   npx tsx tools/lint-determinism.ts            # gate (exit 1 on any violation)
 *   npm run lint:determinism
 *
 * Rules (scoped to *.spec.ts files):
 *   - no blind `waitForTimeout` — use waitUntil / expect.poll / a web-first assertion. A genuine
 *     interaction dwell (canvas/keyboard commit with no observable) is allowed IF the line or the
 *     line above carries a marker: `eslint-disable-line`, `documented`, or `dwell`.
 *   - no `toHaveScreenshot` — Playwright's inline pixel compare is retired; capture via stableShot()
 *     and let the offline tools/screenshots gate compare against tests/baseline-screenshots.
 *   - no `retries` in specs — retries live in the playwright config (and are 0).
 *   - no swallowed `.catch(() => {})` — let failures throw.
 */
import * as fs from 'fs';
import * as path from 'path';

const TESTS_ROOT = path.resolve(__dirname, '..');
const SPEC_DIRS = ['kicad', 'e2e', 'jspi', 'web'];

type Rule = {
  name: string;
  message: string;
  hit: (line: string, prev: string) => boolean;
};

const marker = (s: string) => /eslint-disable|documented|dwell/i.test(s);

const RULES: Rule[] = [
  {
    name: 'no-blind-waitForTimeout',
    message: 'blind waitForTimeout — use waitUntil/expect.poll/web-first assertion, or annotate a documented interaction dwell',
    hit: (line, prev) => /\.waitForTimeout\s*\(/.test(line) && !marker(line) && !marker(prev),
  },
  {
    name: 'no-toHaveScreenshot',
    message: 'toHaveScreenshot does inline pixel comparison — use stableShot() (offline gate)',
    hit: (line) => /toHaveScreenshot/.test(line),
  },
  {
    name: 'no-inline-retries',
    message: 'retries belong in the playwright config (kept at 0), not in specs',
    hit: (line) => /\bretries\s*:/.test(line) && !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'),
  },
  {
    name: 'no-swallowed-catch',
    message: 'swallowed .catch(() => {}) hides failures — let it throw, assert the tolerated outcome, or annotate why it is best-effort',
    hit: (line, prev) => /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(line) && !marker(line) && !marker(prev),
  },
];

function specFiles(dir: string): string[] {
  const abs = path.join(TESTS_ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const p = path.join(abs, entry.name);
    if (entry.isDirectory()) out.push(...specFiles(path.join(dir, entry.name)));
    else if (entry.name.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

const violations: { file: string; line: number; rule: string; message: string; text: string }[] = [];
const files = SPEC_DIRS.flatMap(specFiles);

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const trimmed = line.trimStart();
    // Skip pure-comment lines — they describe, they don't execute. (Markers on a real code
    // line are still seen because rule.hit receives the full line, comment included.)
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    const prev = i > 0 ? lines[i - 1] : '';
    for (const rule of RULES) {
      if (rule.hit(line, prev)) {
        violations.push({ file: path.relative(TESTS_ROOT, file), line: i + 1, rule: rule.name, message: rule.message, text: line.trim() });
      }
    }
  });
}

if (violations.length === 0) {
  console.log(`✓ determinism guard: ${files.length} spec files clean`);
  process.exit(0);
}

console.error(`✗ determinism guard: ${violations.length} violation(s) across ${files.length} spec files\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  [${v.rule}]`);
  console.error(`      ${v.text}`);
  console.error(`      → ${v.message}\n`);
}
process.exit(1);
