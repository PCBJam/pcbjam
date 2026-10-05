// Before/after visual check for style refactors (e.g. the src/brand move):
//   GITHUB_SHA=0000000 npm run build && cp -R dist /tmp/before   (on the old commit)
//   node scripts/visual-diff.mjs /tmp/before /tmp/shots-before 4391
// then the same for the new build, and compare the PNGs (cmp). External requests
// are blocked and lazy images forced eager so shots are byte-stable.
// Playwright is not a site dependency: PLAYWRIGHT_MODULE points at an install.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const [dir, out, port] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const srv = spawn('python3', ['-m', 'http.server', port, '--bind', '127.0.0.1'], { cwd: dir, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 800));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
await ctx.route('**/*', r => (new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort()));
const pages = { home: '/', pricing: '/pricing/', blog: '/blog/devblog-2026-w39/', terms: '/terms/', mobile: '/' };
for (const [name, path] of Object.entries(pages)) {
  const p = await ctx.newPage();
  if (name === 'mobile') await p.setViewportSize({ width: 390, height: 800 });
  await p.goto(`http://127.0.0.1:${port}${path}`, { waitUntil: 'networkidle' });
  await p.evaluate(async () => { document.querySelectorAll('img[loading=lazy]').forEach(i => (i.loading = 'eager')); await Promise.all([...document.images].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }))); await document.fonts.ready; });
  await p.screenshot({ path: `${out}/${name}.png`, fullPage: true, animations: 'disabled' });
  await p.close();
}
await browser.close(); srv.kill();
