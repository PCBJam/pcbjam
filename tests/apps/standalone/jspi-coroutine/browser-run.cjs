// Quick browser validation of the jspi-coroutine harness in bundled
// Chromium 143 (JSPI default-on) and Firefox 144 (JSPI behind pref).
// Uses the main checkout's installed Playwright. Proper spec wiring lands in
// tests/jspi/ (Phase 6).
const path = require('path');
const http = require('http');
const fs = require('fs');

const PW = '/Users/V/IdeaProjects/pcbjam-private/pcbjam/tests/node_modules/playwright';
const { chromium, firefox } = require(PW);

const DIR = __dirname;
const MIME = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm' };

async function runIn(name, launcher, opts) {
  const browser = await launcher.launch(opts);
  const page = await browser.newPage();
  const lines = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('[JSPI_CORO]') || t.includes('[libctx-jspi]')) lines.push(t);
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.waitForFunction(
    () => performance.now() > 0, // anchor; real wait below
  );
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !lines.some((l) => l.includes('SUMMARY'))) {
    await new Promise((r) => setTimeout(r, 200));
  }
  await browser.close();
  const summary = lines.find((l) => l.includes('SUMMARY')) ?? 'NO SUMMARY';
  const fails = lines.filter((l) => l.includes('FAIL') || l.includes('FATAL'));
  console.log(`${name}: ${summary}`);
  for (const f of fails) console.log(`${name}: ${f}`);
  return summary.includes('failed=0');
}

const server = http.createServer((req, res) => {
  const f = path.join(DIR, req.url === '/' ? 'index.html' : req.url);
  try {
    const body = fs.readFileSync(f);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});

server.listen(0, '127.0.0.1', async () => {
  let ok = true;
  ok = (await runIn('chromium', chromium, {})) && ok;
  ok = (await runIn('firefox', firefox, {
    firefoxUserPrefs: { 'javascript.options.wasm_js_promise_integration': true },
  })) && ok;
  server.close();
  process.exit(ok ? 0 : 1);
});
