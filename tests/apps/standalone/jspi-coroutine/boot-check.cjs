// Boot-check a built wx test app under JSPI in bundled Chromium (+ optionally
// Firefox with the pref). Usage: node boot-check.cjs <app.html> [firefox]
const path = require('path');
const http = require('http');
const fs = require('fs');

const PW = '/Users/V/IdeaProjects/pcbjam-private/pcbjam/tests/node_modules/playwright';
const { chromium, firefox } = require(PW);

const APPS = '/Users/V/IdeaProjects/kicad-wasm-jspi/tests/apps';
const page_url = process.argv[2] || 'minimal_test.html';
const useFirefox = process.argv[3] === 'firefox';

const MIME = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.data': 'application/octet-stream' };

const server = http.createServer((req, res) => {
  const f = path.join(APPS, decodeURIComponent(req.url.split('?')[0]));
  try {
    const body = fs.readFileSync(f);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(f)] ?? 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});

server.listen(0, '127.0.0.1', async () => {
  const launcher = useFirefox ? firefox : chromium;
  const opts = useFirefox
    ? { firefoxUserPrefs: { 'javascript.options.wasm_js_promise_integration': true } }
    : {};
  const browser = await launcher.launch(opts);
  const page = await browser.newPage();
  const lines = [];
  page.on('console', (m) => lines.push(m.text()));
  page.on('pageerror', (e) => lines.push('PAGEERROR: ' + e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/${page_url}`);
  await new Promise((r) => setTimeout(r, 12000));
  // Probe scheduler state + DOM
  const probe = await page.evaluate(() => ({
    scheduler: globalThis.__wxScheduler ? globalThis.__wxScheduler.backend : null,
    dump: globalThis.__wxWaitDump ? globalThis.__wxWaitDump() : null,
    windows: document.querySelectorAll('.wx-window, [id^=wx]').length,
    bodyChildren: document.body.children.length,
  })).catch((e) => ({ error: String(e) }));
  await browser.close();
  server.close();
  console.log('=== console (last 30) ===');
  for (const l of lines.slice(-30)) console.log(l);
  console.log('=== probe ===');
  console.log(JSON.stringify(probe, null, 1));
  const bad = lines.filter((l) => /PAGEERROR|SuspendError|RuntimeError|abort/i.test(l));
  console.log(bad.length ? 'BOOT: ERRORS(' + bad.length + ')' : 'BOOT: CLEAN');
});
