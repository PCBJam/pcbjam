/**
 * CI-coverage guard: every spec file on disk must be RUN BY CI. Fails (exit 1)
 * if a test can be added without CI ever executing it — the failure mode that
 * let the web suite rot unrun for months. Run locally or in CI:
 *
 *   npx tsx tools/lint-ci-coverage.ts            # gate (exit 1 on any violation)
 *   npm run lint:ci-coverage
 *
 * Both sides come from ground truth, no hand-maintained file lists:
 *   - "what CI runs": `npm run test:…` invocations scraped from
 *     .github/workflows/*.yml, resolved through package.json to their
 *     `playwright test --config/--project` flags;
 *   - "what that covers": `playwright test --list --reporter=json` with those
 *     exact flags (CI=1), so testDir/testMatch/testIgnore/project semantics are
 *     Playwright's own, never re-implemented here.
 *
 * Rules:
 *   - uncovered-spec: a *.spec.ts under tests/ that no CI invocation lists.
 *   - orphan-project: a project defined in a config that no CI script selects
 *     and that is not explicitly allowlisted as local-only below.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const TESTS_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(TESTS_ROOT, '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

// Deliberately-local projects (system browsers CI does not install, or manual
// policy runs). A NEW project must either be selected by a CI-invoked script
// or be added here on purpose — silence is exactly how the web suite rotted.
const LOCAL_ONLY_PROJECTS = new Set([
  'kicad-chrome', // system Chrome, headed KiCad debugging
  'jspi-chrome', // system Chrome (real V8; run manually via test:jspi:chrome)
  'coroutine-chrome', // system Chrome (real V8/GPU)
]);

// Dirs under tests/ that never contain source specs.
const EXCLUDED_DIRS = new Set([
  'node_modules',
  'apps',
  'fixtures',
  'test-results',
  'pw-artifacts',
  'playwright-report',
  'logs',
  'baseline-screenshots',
  '3d-regression',
  'tools',
  'collab',
  'scripts',
]);

// ── 1. what CI invokes ────────────────────────────────────────────────────────
function ciTestScripts(): string[] {
  const names = new Set<string>();
  for (const f of fs.readdirSync(WORKFLOWS_DIR)) {
    if (!/\.ya?ml$/.test(f)) continue;
    const body = fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8');
    for (const m of body.matchAll(/npm run (test:[\w:.-]+)/g)) names.add(m[1]);
  }
  if (!names.size) {
    throw new Error(
      `no "npm run test:…" invocations found under ${WORKFLOWS_DIR} — ` +
        'either CI stopped running tests or this lint\'s scrape regex rotted'
    );
  }
  return [...names].sort();
}

// ── 2. resolve scripts to playwright invocations ─────────────────────────────
type Invocation = { script: string; config: string; projects: string[] };

function resolveScript(name: string): Invocation {
  const pkg = JSON.parse(fs.readFileSync(path.join(TESTS_ROOT, 'package.json'), 'utf8'));
  const body: string | undefined = pkg.scripts?.[name];
  if (!body) throw new Error(`CI invokes "npm run ${name}" but tests/package.json has no such script`);

  const segment = body
    .split('&&')
    .map((s) => s.trim())
    .find((s) => /(^|\s)playwright test(\s|$)/.test(s));
  if (!segment) {
    throw new Error(
      `CI script "${name}" ("${body}") contains no "playwright test" segment — ` +
        'unknown runner; extend lint-ci-coverage.ts to understand it'
    );
  }

  const config = segment.match(/--config=(\S+)/)?.[1] ?? 'playwright.config.ts';
  const projects = [...segment.matchAll(/--project=(\S+)/g)].map((m) => m[1]);
  return { script: name, config, projects };
}

// ── 3. what those invocations cover ───────────────────────────────────────────
type ListResult = { files: Set<string>; definedProjects: Set<string> };

function listInvocation(inv: Invocation): ListResult {
  const args = ['playwright', 'test', '--list', '--reporter=json', `--config=${inv.config}`];
  for (const p of inv.projects) args.push(`--project=${p}`);
  const out = execFileSync('npx', args, {
    cwd: TESTS_ROOT,
    env: { ...process.env, CI: '1' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const report = JSON.parse(out);

  // Reported file paths are relative to the config's rootDir (tests/ for the
  // merged config, tests/web for the web one) — normalize to tests/-relative.
  const rootDir: string = report.config?.rootDir ?? TESTS_ROOT;
  const normalize = (f: string) => path.relative(TESTS_ROOT, path.resolve(rootDir, f));

  const files = new Set<string>();
  const walk = (suite: { file?: string; suites?: unknown[]; specs?: { file?: string }[] }) => {
    if (suite.file) files.add(normalize(suite.file));
    for (const spec of suite.specs ?? []) if (spec.file) files.add(normalize(spec.file));
    for (const sub of (suite.suites ?? []) as typeof suite[]) walk(sub);
  };
  for (const s of report.suites ?? []) walk(s);

  const definedProjects = new Set<string>(
    (report.config?.projects ?? []).map((p: { name: string }) => p.name)
  );
  return { files, definedProjects };
}

// ── 4. the universe of spec files on disk ─────────────────────────────────────
function specUniverse(dir = TESTS_ROOT, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      out.push(...specUniverse(path.join(dir, entry.name), path.join(rel, entry.name)));
    } else if (entry.name.endsWith('.spec.ts')) {
      out.push(path.join(rel, entry.name));
    }
  }
  return out;
}

// ── run ───────────────────────────────────────────────────────────────────────
const invocations = ciTestScripts().map(resolveScript);

const covered = new Set<string>();
const defined = new Map<string, string>(); // project -> config that defines it
const selected = new Set<string>();
for (const inv of invocations) {
  const { files, definedProjects } = listInvocation(inv);
  for (const f of files) covered.add(f);
  for (const p of definedProjects) if (!defined.has(p)) defined.set(p, inv.config);
  for (const p of inv.projects) selected.add(p);
}

const universe = specUniverse().sort();
const violations: string[] = [];

for (const file of universe) {
  if (!covered.has(file)) {
    violations.push(
      `uncovered-spec: tests/${file} is not listed by any CI-invoked playwright run ` +
        `(scripts: ${invocations.map((i) => i.script).join(', ')})`
    );
  }
}

for (const [project, config] of [...defined.entries()].sort()) {
  if (!selected.has(project) && !LOCAL_ONLY_PROJECTS.has(project)) {
    violations.push(
      `orphan-project: "${project}" (${config}) is selected by no CI script and not in ` +
        'LOCAL_ONLY_PROJECTS — wire it into a CI npm script or allowlist it on purpose'
    );
  }
}

if (violations.length) {
  for (const v of violations) console.error(`✗ ${v}`);
  console.error(`\n${violations.length} CI-coverage violation(s)`);
  process.exit(1);
}

console.log(
  `✓ CI coverage: ${universe.length} spec files all reachable via ` +
    `${invocations.map((i) => i.script).join(' + ')}; ` +
    `${defined.size} projects accounted for (${selected.size} on CI, ${LOCAL_ONLY_PROJECTS.size} local-only)`
);
