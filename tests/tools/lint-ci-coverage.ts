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
 *   - all-fixme-spec: CI lists the file, but every selected test is a static
 *     fixme, so the file contributes no executable signal.
 *   - orphan-project: a project defined in a config that no CI script selects
 *     and that is not explicitly allowlisted as local-only below.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import ts from "typescript";

const TESTS_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(TESTS_ROOT, "..");
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");

// Deliberately-local projects (system browsers CI does not install, or manual
// policy runs). A NEW project must either be selected by a CI-invoked script
// or be added here on purpose — silence is exactly how the web suite rotted.
const LOCAL_ONLY_PROJECTS = new Set([
  "kicad-chrome", // system Chrome, headed KiCad debugging
  "asyncify-chrome", // system Chrome
  "asyncify-webkit", // Safari-engine policy suite, run manually (test:asyncify:safari)
  "coroutine-chrome", // system Chrome (real V8/GPU)
]);

// Dirs under tests/ that never contain source specs.
const EXCLUDED_DIRS = new Set([
  "node_modules",
  "apps",
  "fixtures",
  "test-results",
  "pw-artifacts",
  "playwright-report",
  "logs",
  "baseline-screenshots",
  "3d-regression",
  "tools",
  "collab",
  "scripts",
]);

// ── 1. what CI invokes ────────────────────────────────────────────────────────
export function extractTestScriptsFromWorkflow(body: string): string[] {
  const names = new Set<string>();
  // Match command text in a YAML `run:` scalar only. In particular, do not
  // accept a step display name such as "e2e (npm run test:e2e)" as evidence
  // that CI executes the script. Block scalars continue while indented past
  // their `run: |` line; plain/folded scalars contribute their inline text.
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const run = lines[i]!.match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!run) continue;
    const indent = run[1]!.length;
    let command = run[2]!;
    if (/^[|>][-+]?\s*$/.test(command)) {
      command = "";
      for (i++; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.trim() && line.match(/^\s*/)?.[0].length! <= indent) {
          i--;
          break;
        }
        command += `\n${line}`;
      }
    }
    for (const line of command.split(/\r?\n/)) {
      for (const segment of line.split(/&&|;/)) {
        const m = segment
          .trim()
          .match(
            /^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:xvfb-run(?:\s+(?!npm\b)\S+)*\s+)?npm\s+run\s+(test:[\w:.-]+)(.*)$/,
          );
        if (!m) continue;
        names.add(m[1]!);
        const trailing = m[2]!.trim();
        if (trailing) {
          throw new Error(
            `unsupported arguments after "npm run ${m[1]}": ${trailing}; ` +
              "forward them through lint-ci-coverage.ts instead of silently broadening CI coverage",
          );
        }
      }
    }
  }
  return [...names].sort();
}

export function ciTestScripts(): string[] {
  const names = new Set<string>();
  for (const f of fs.readdirSync(WORKFLOWS_DIR)) {
    if (!/\.ya?ml$/.test(f)) continue;
    const body = fs.readFileSync(path.join(WORKFLOWS_DIR, f), "utf8");
    for (const name of extractTestScriptsFromWorkflow(body)) names.add(name);
  }
  if (!names.size) {
    throw new Error(
      `no "npm run test:…" invocations found under ${WORKFLOWS_DIR} — ` +
        "either CI stopped running tests or this lint's scrape regex rotted",
    );
  }
  return [...names].sort();
}

// ── 2. resolve scripts to playwright invocations ─────────────────────────────
type Invocation = {
  script: string;
  config: string;
  projects: string[];
  runnerArgs: string[];
};

export function resolveScript(name: string): Invocation {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(TESTS_ROOT, "package.json"), "utf8"),
  );
  const body: string | undefined = pkg.scripts?.[name];
  if (!body)
    throw new Error(
      `CI invokes "npm run ${name}" but tests/package.json has no such script`,
    );

  const segment = body
    .split("&&")
    .map((s) => s.trim())
    .find((s) => /(^|\s)playwright test(\s|$)/.test(s));
  if (!segment) {
    throw new Error(
      `CI script "${name}" ("${body}") contains no "playwright test" segment — ` +
        "unknown runner; extend lint-ci-coverage.ts to understand it",
    );
  }

  // Preserve every selector (`--grep`, positional paths, shards, and so on)
  // when reconstructing `--list`. Keeping only config/project silently turns a
  // narrowed CI command into apparent whole-suite coverage.
  const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const playwright = tokens.findIndex(
    (token, index) => token === "playwright" && tokens[index + 1] === "test",
  );
  if (playwright < 0)
    throw new Error(
      `cannot tokenize Playwright segment in "${name}": ${segment}`,
    );
  const runnerArgs = tokens
    .slice(playwright + 2)
    .map((token) => token.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2"));
  if (
    runnerArgs.some((arg) => arg === "--list" || arg.startsWith("--reporter"))
  ) {
    throw new Error(
      `CI script "${name}" controls --list/--reporter itself; ` +
        "lint-ci-coverage.ts cannot reconstruct it safely",
    );
  }

  let config = "playwright.config.ts";
  const projects: string[] = [];
  for (let i = 0; i < runnerArgs.length; i++) {
    const arg = runnerArgs[i]!;
    if (arg === "--config") {
      if (!runnerArgs[i + 1])
        throw new Error(`missing --config value in CI script "${name}"`);
      config = runnerArgs[++i]!;
    } else if (arg.startsWith("--config=")) {
      config = arg.slice("--config=".length);
    } else if (arg === "--project") {
      if (!runnerArgs[i + 1])
        throw new Error(`missing --project value in CI script "${name}"`);
      projects.push(runnerArgs[++i]!);
    } else if (arg.startsWith("--project=")) {
      projects.push(arg.slice("--project=".length));
    }
  }
  return { script: name, config, projects, runnerArgs };
}

// ── 3. what those invocations cover ───────────────────────────────────────────
type ListResult = {
  files: Set<string>;
  nonFixmeFiles: Set<string>;
  runnableFiles: Set<string>;
  projectFiles: Map<string, Set<string>>;
  definedProjects: Set<string>;
};

function listInvocation(inv: Invocation): ListResult {
  const args = [
    "playwright",
    "test",
    ...inv.runnerArgs,
    "--list",
    "--reporter=json",
  ];
  const out = execFileSync("npx", args, {
    cwd: TESTS_ROOT,
    env: { ...process.env, CI: "1" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const report = JSON.parse(out);

  // Reported file paths are relative to the config's rootDir (tests/ for the
  // merged config, tests/web for the web one) — normalize to tests/-relative.
  const rootDir: string = report.config?.rootDir ?? TESTS_ROOT;
  const normalize = (f: string) =>
    path.relative(TESTS_ROOT, path.resolve(rootDir, f));

  const files = new Set<string>();
  const nonFixmeFiles = new Set<string>();
  const runnableFiles = new Set<string>();
  const projectFiles = new Map<string, Set<string>>();
  type ListedSpec = {
    file?: string;
    tests?: {
      expectedStatus?: string;
      projectName?: string;
      annotations?: { type?: string }[];
    }[];
  };
  type ListedSuite = {
    file?: string;
    suites?: ListedSuite[];
    specs?: ListedSpec[];
  };
  const walk = (suite: ListedSuite) => {
    if (suite.file) files.add(normalize(suite.file));
    for (const spec of suite.specs ?? []) {
      if (!spec.file) continue;
      const file = normalize(spec.file);
      files.add(file);
      for (const listedTest of spec.tests ?? []) {
        if (listedTest.expectedStatus !== "skipped") runnableFiles.add(file);
        if (listedTest.projectName) {
          let projectSet = projectFiles.get(listedTest.projectName);
          if (!projectSet) {
            projectSet = new Set<string>();
            projectFiles.set(listedTest.projectName, projectSet);
          }
          projectSet.add(file);
        }
      }
      // `--list` marks every result as skipped because nothing is executed.
      // A declaration-level test.fixme is instead identified by both its
      // expected status and static annotation. Conditional/runtime skips are
      // deliberately not treated as fixmes: this rule must not disturb the
      // explicit GPU/platform quarantines tracked elsewhere.
      if (
        (spec.tests ?? []).some(
          (test) =>
            test.expectedStatus !== "skipped" ||
            !(test.annotations ?? []).some(
              (annotation) => annotation.type === "fixme",
            ),
        )
      ) {
        nonFixmeFiles.add(file);
      }
    }
    for (const sub of suite.suites ?? []) walk(sub);
  };
  for (const s of report.suites ?? []) walk(s);

  const definedProjects = new Set<string>(
    (report.config?.projects ?? []).map((p: { name: string }) => p.name),
  );
  return { files, nonFixmeFiles, runnableFiles, projectFiles, definedProjects };
}

// ── 4. the universe of spec files on disk ─────────────────────────────────────
export function specUniverse(dir = TESTS_ROOT, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      out.push(
        ...specUniverse(path.join(dir, entry.name), path.join(rel, entry.name)),
      );
    } else if (entry.name.endsWith(".spec.ts")) {
      out.push(path.join(rel, entry.name));
    }
  }
  return out;
}

// ── run ───────────────────────────────────────────────────────────────────────
export function main(): void {
  const parserProbe = extractTestScriptsFromWorkflow(`
steps:
  - name: fake text npm run test:not-executed
    run: echo not-a-test
  - name: real command
    run: |
      npm run test:alpha
      npm run test:beta
`);
  if (parserProbe.join(",") !== "test:alpha,test:beta") {
    throw new Error(
      `workflow run-scalar parser self-test failed: ${parserProbe.join(",")}`,
    );
  }
  const invocations = ciTestScripts().map(resolveScript);

  const covered = new Set<string>();
  const nonFixme = new Set<string>();
  const runnable = new Set<string>();
  const coveredByProject = new Map<string, Set<string>>();
  const defined = new Map<string, string>(); // project -> config that defines it
  const selected = new Set<string>();
  for (const inv of invocations) {
    const {
      files,
      nonFixmeFiles,
      runnableFiles,
      projectFiles,
      definedProjects,
    } = listInvocation(inv);
    for (const f of files) covered.add(f);
    for (const f of nonFixmeFiles) nonFixme.add(f);
    for (const f of runnableFiles) runnable.add(f);
    for (const [project, filesForProject] of projectFiles) {
      let aggregate = coveredByProject.get(project);
      if (!aggregate) {
        aggregate = new Set<string>();
        coveredByProject.set(project, aggregate);
      }
      for (const file of filesForProject) aggregate.add(file);
    }
    for (const p of definedProjects)
      if (!defined.has(p)) defined.set(p, inv.config);
    for (const p of inv.projects) selected.add(p);
  }

  const universe = specUniverse().sort();
  const violations: string[] = [];

  // The shipped raytracer currently renders a uniform black frame, so the real-
  // application camera-deadlock prerequisite cannot be engaged. Keep this one
  // quarantine explicit: an all-skipped file anywhere else is a coverage error.
  const ALL_SKIPPED_ALLOWLIST = new Set(["kicad/3d-viewer-deadlock.spec.ts"]);

  // Runtime modifiers cannot be resolved by `playwright --list`. Every remaining
  // occurrence is listed here with a concrete reason so a new self-skip never
  // becomes invisible CI behavior. Entries are source-audited below; this is a
  // deliberate quarantine registry, not a general exemption.
  const RUNTIME_MODIFIER_ALLOWLIST = new Map<string, string>([
    [
      "e2e/maximize.spec.ts",
      "tracked wxDisplay geometry defect; other maximize tests remain active",
    ],
    [
      "kicad/3d-viewer-deadlock.spec.ts",
      "real GPU prerequisite plus tracked black-frame defect",
    ],
    [
      "kicad/collab-load-fuzz.spec.ts",
      "opt-in natural-park CPU-starvation stress hunt",
    ],
    [
      "kicad/drift-trio-fuzz.spec.ts",
      "manual seeded fuzz plus Firefox wasm-memory limit",
    ],
    [
      "kicad/drift-trio-scenarios.spec.ts",
      "tracked CRDT convergence quarantine plus Firefox wasm-memory limit",
    ],
    ["kicad/drift-trio.spec.ts", "three-editor Firefox wasm-memory limit"],
    ["kicad/eeschema-collab.spec.ts", "two-editor Firefox wasm-memory limit"],
    ["kicad/pcbnew-collab.spec.ts", "two-editor Firefox wasm-memory limit"],
    ["kicad/ysync-libsymbols.spec.ts", "two-editor Firefox wasm-memory limit"],
    ["kicad/ysync-two-tab.spec.ts", "two-editor Firefox wasm-memory limit"],
    ["kicad/zoom-cursor.spec.ts", "headed-Xvfb Firefox coordinate defect"],
  ]);

  // Required engine reachability. This is intentionally stronger for the
  // scheduler/coroutine reducers than the ordinary widget suite, and keeps the
  // full KiCad and desktop-web specs on both bundled desktop engines.
  function requiredProjects(file: string): string[] {
    if (file.startsWith("asyncify/"))
      return ["asyncify-firefox", "asyncify-chromium"];
    if (/^e2e\/coroutine.*\.spec\.ts$/.test(file)) {
      return ["wx-chromium", "coroutine-firefox"];
    }
    if (file === "e2e/pending-event-owner.spec.ts") {
      return ["wx-chromium", "coroutine-firefox"];
    }
    if (file.startsWith("kicad/") && !file.endsWith("-perf.spec.ts")) {
      return ["kicad-firefox", "kicad-chromium"];
    }
    if (file.startsWith("web/")) {
      return /(^|\/)mobile-.*\.spec\.ts$/.test(file)
        ? ["web-mobile"]
        : ["web-firefox", "web-chromium"];
    }
    return [];
  }

  function hasRuntimeModifier(file: string): boolean {
    const absolute = path.join(TESTS_ROOT, file);
    const source = ts.createSourceFile(
      absolute,
      fs.readFileSync(absolute, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "test" &&
        (node.expression.name.text === "skip" ||
          node.expression.name.text === "fixme")
      ) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  }

  for (const file of universe) {
    if (!covered.has(file)) {
      violations.push(
        `uncovered-spec: tests/${file} is not listed by any CI-invoked playwright run ` +
          `(scripts: ${invocations.map((i) => i.script).join(", ")})`,
      );
    } else if (!nonFixme.has(file)) {
      violations.push(
        `all-fixme-spec: tests/${file} is selected by CI, but every listed test is ` +
          "a static fixme",
      );
    } else if (!runnable.has(file) && !ALL_SKIPPED_ALLOWLIST.has(file)) {
      violations.push(
        `all-skipped-spec: tests/${file} is selected by CI, but every listed test is ` +
          "statically skipped",
      );
    }

    for (const project of requiredProjects(file)) {
      if (!coveredByProject.get(project)?.has(file)) {
        violations.push(
          `missing-engine-coverage: tests/${file} is not selected by required CI project ` +
            `"${project}"`,
        );
      }
    }

    const runtimeModifier = hasRuntimeModifier(file);
    if (runtimeModifier && !RUNTIME_MODIFIER_ALLOWLIST.has(file)) {
      violations.push(
        `unregistered-runtime-skip: tests/${file} contains test.skip()/test.fixme(), ` +
          "which --list cannot evaluate; remove it or add an audited quarantine reason",
      );
    } else if (!runtimeModifier && RUNTIME_MODIFIER_ALLOWLIST.has(file)) {
      violations.push(
        `stale-runtime-skip-allowlist: tests/${file} no longer contains a runtime ` +
          "modifier; remove its quarantine entry",
      );
    }
  }

  for (const [project, config] of [...defined.entries()].sort()) {
    if (!selected.has(project) && !LOCAL_ONLY_PROJECTS.has(project)) {
      violations.push(
        `orphan-project: "${project}" (${config}) is selected by no CI script and not in ` +
          "LOCAL_ONLY_PROJECTS — wire it into a CI npm script or allowlist it on purpose",
      );
    }
  }

  if (violations.length) {
    for (const v of violations) console.error(`✗ ${v}`);
    console.error(`\n${violations.length} CI-coverage violation(s)`);
    process.exit(1);
  }

  console.log(
    `✓ CI coverage: ${universe.length} spec files all reachable and none all-fixme via ` +
      `${invocations.map((i) => i.script).join(" + ")}; ` +
      `${defined.size} projects accounted for (${selected.size} on CI, ${LOCAL_ONLY_PROJECTS.size} local-only); ` +
      `${ALL_SKIPPED_ALLOWLIST.size} explicit all-skipped quarantine`,
  );
}

if (require.main === module) main();
