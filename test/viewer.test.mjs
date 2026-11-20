// Браузерный тест просмотрщика на демо-трейсе trace.json: `npm test`.
// Поднимает статический сервер (как GitHub Pages) и гоняет страницу в headless Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const ROOT = new URL('..', import.meta.url).pathname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json' };
const ROOT_SPAN = '0000000000001034';   // POST /api/reports/monthly — корень 12-секундной операции
const DEEP_SPAN = '0000000000001036';   // третий уровень: 1034 → 1035 → 1036

let server, browser, base;

// fake SignalFx API: 2 segments overlapping by 10 spans, the second shaped as {spans};
// 401 for trace 'bad' or without the X-SF-Token the UI keeps in localStorage['X-SF-TOKEN']
const SF_TOKEN = 'test-token';
async function fakeSfxApi(req, res, id, seg) {
  if (id === 'bad' || req.headers['x-sf-token'] !== SF_TOKEN) return res.writeHead(401).end();
  const spans = JSON.parse(await readFile(join(ROOT, 'trace.json'), 'utf8')).spans, h = spans.length >> 1;
  const body = { segments: ['s1', 's2'], s1: spans.slice(0, h + 10), s2: { spans: spans.slice(h) } }[seg];
  if (!body) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
before(async () => {
  server = http.createServer(async (req, res) => {
    let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    if (path === '/') path = '/index.html';
    const api = path.match(/^\/v2\/apm\/trace\/([^/]+)\/([^/]+)$/);
    if (api) return fakeSfxApi(req, res, api[1], api[2]);
    try {
      const body = await readFile(join(ROOT, path));
      res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

async function open(hash) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/${hash}`);
  await page.waitForFunction(() => window.__viewer?.S.spans.length > 0);
  return { page, errors };
}
const subtree = (page, id) => page.evaluate(id => {
  const S = window.__viewer.S, out = [], st = [id];
  while (st.length) { const x = st.pop(); out.push(x); (S.children.get(x) || []).forEach(c => st.push(c.id)); }
  return out;
}, id);
const rowIds = page => page.$$eval('.row[data-id]', rs => rs.map(r => r.dataset.id));

test('корень Pages (index.html) ведёт на просмотрщик и сохраняет #span', async () => {
  const { page } = await open(`#span=${ROOT_SPAN}`);
  assert.match(page.url(), new RegExp(`trace_viewer\\.html#span=${ROOT_SPAN}$`));
  await page.close();
});

test('ссылка #span показывает поддерево целиком и путь от корня над ним', async () => {
  const { page, errors } = await open(`trace_viewer.html#span=${DEEP_SPAN}`);
  const rows = await rowIds(page);
  const sub = await subtree(page, DEEP_SPAN);
  assert.deepEqual(rows.slice(0, 3), [ROOT_SPAN, '0000000000001035', DEEP_SPAN]);
  assert.equal(rows.length, 2 + sub.length);
  assert.ok(sub.every(id => rows.includes(id)));
  assert.equal(await page.evaluate(() => window.__viewer.S.selId), DEEP_SPAN);
  assert.deepEqual(errors, []);
  await page.close();
});

test('self time: 0 ≤ self ≤ dur у всех спанов, у корня — время без детей', async () => {
  const { page } = await open('trace_viewer.html');
  const r = await page.evaluate(id => {
    const S = window.__viewer.S;
    return { bad: S.spans.filter(s => !(s.self >= 0 && s.self <= s.dur + 1e-9)).length, root: S.byId.get(id).self };
  }, ROOT_SPAN);
  assert.equal(r.bad, 0);
  assert.ok(Math.abs(r.root - 303) < 1, `self корня ${r.root}`);   // 120 с минус generate-monthly и s3
  await page.close();
});

test('критический путь проходит сквозь перекрытие s3 / generate-monthly до листьев', async () => {
  const { page } = await open(`trace_viewer.html#span=${ROOT_SPAN}`);
  await page.check('#critOn');
  const ops = await page.$$eval('.row.crit .op', rs => rs.map(r => r.textContent));
  assert.ok(ops.includes('generate-monthly'));
  assert.ok(ops.some(o => o.startsWith('render-chunk/')));
  assert.ok(ops.includes('draw-page'));
  assert.ok(await page.$$eval('.row.nocrit', rs => rs.length) > 0);
  await page.close();
});

test('«Почему медленно» находит повторы ×60 и фильтрует по клику', async () => {
  const { page, errors } = await open(`trace_viewer.html#span=${ROOT_SPAN}`);
  await page.click('#btnWhy');
  const groups = await page.$$eval('#details tr[data-q]', rs => rs.map(r => [r.dataset.q, r.querySelector('.n1')?.textContent || '']));
  const badge = Object.fromEntries(groups);
  assert.equal(badge['draw-page'], '×60');
  assert.equal(badge['SELECT * FROM billing_rows'], '×60');
  assert.equal(badge['generate-monthly'], '');
  await page.click('#details tr[data-q="draw-page"]');
  assert.equal(await page.inputValue('#search'), 'draw-page');
  assert.equal((await rowIds(page)).length, 60);   // вышли из поддерева — фильтр не срезает ветки
  assert.deepEqual(errors, []);
  await page.close();
});

test('fmtDur: 2 минуты — «2m0s», а не «1m60s»', async () => {
  const { page } = await open(`trace_viewer.html#span=${ROOT_SPAN}`);
  await page.click('#btnWhy');
  const txt = await page.textContent('#details');
  assert.ok(txt.includes('2m0s') && !txt.includes('1m60s'));
  await page.close();
});

const traceJson = async () => JSON.parse(await readFile(join(ROOT, 'trace.json'), 'utf8'));
async function openSfx(path = 'trace_viewer.html?from=sfx') {
  const page = await browser.newPage();
  const errors = [], dialogs = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  await page.goto(`${base}/${path}`);
  await page.waitForFunction(() => window.__viewer);
  return { page, errors, dialogs };
}

test('?from=sfx: loads a trace from postMessage and skips the demo', async () => {
  const { page, errors } = await openSfx();
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__viewer.S.spans.length), 0);
  const spans = (await traceJson()).spans.slice(0, 50);
  await page.evaluate(spans => window.postMessage({ type: 'sfx-trace', name: 'x', data: { traceId: 't1', spans } }, '*'), spans);
  await page.waitForFunction(() => window.__viewer.S.spans.length > 0);
  assert.equal(await page.evaluate(() => window.__viewer.S.spans.length), 50);
  assert.equal(await page.evaluate(() => window.__viewer.S.traceId), 't1');
  assert.deepEqual(errors, []);
  await page.close();
});

test('?from=sfx: ignores messages from a foreign window', async () => {
  const { page } = await openSfx();
  const spans = (await traceJson()).spans.slice(0, 50);
  await page.evaluate(spans => {
    const f = document.createElement('iframe');
    document.body.append(f);
    f.contentWindow.eval(`parent.postMessage(${JSON.stringify({ type: 'sfx-trace', name: 'evil', data: { traceId: 'evil', spans } })}, '*')`);
  }, spans);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__viewer.S.spans.length), 0);
  await page.close();
});

test('?from=sfx: bad data shows an alert without crashing', async () => {
  const { page, errors, dialogs } = await openSfx();
  await page.evaluate(() => window.postMessage({ type: 'sfx-trace', name: 'x', data: 42 }, '*'));
  await page.waitForTimeout(300);
  assert.equal(dialogs.length, 1);
  assert.deepEqual(errors, []);
  await page.close();
});

async function sfxPage(traceId, token = SF_TOKEN) {
  const page = await browser.newPage();
  const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  await page.goto(`${base}/test/fake-sfx.html#/apm/traces/${traceId}`);
  await page.evaluate(([v, t]) => {
    window.SFX_GRAB = { viewerUrl: v };
    if (t) localStorage.setItem('X-SF-TOKEN', t);
  }, [`${base}/trace_viewer.html`, token]);
  const grab = () => page.addScriptTag({ path: join(ROOT, 'extension/sfx-grab.js') });
  return { page, dialogs, grab };
}

test('sfx-grab: merges segments without duplicates and opens the viewer', async () => {
  const total = (await traceJson()).spans.length;
  const { page, dialogs, grab } = await sfxPage('abc');
  const [viewer, download] = await Promise.all([page.waitForEvent('popup'), page.waitForEvent('download'), grab()]);
  assert.equal(download.suggestedFilename(), 'trace-abc.json');
  await viewer.waitForFunction(() => window.__viewer?.S.spans.length > 0);
  assert.equal(await viewer.evaluate(() => window.__viewer.S.spans.length), total);
  assert.equal(await viewer.evaluate(() => window.__viewer.S.traceId), 'abc');
  assert.deepEqual(dialogs, []); // opens without a confirm
  await viewer.close(); await page.close();
});

test('sfx-grab: 401 shows an auth error and closes the viewer window', async () => {
  const { page, dialogs, grab } = await sfxPage('bad');
  const [viewer] = await Promise.all([page.waitForEvent('popup'), grab()]);
  await page.waitForTimeout(500);
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0], /not authorized/);
  assert.ok(viewer.isClosed());
  await page.close();
});

test('sfx-grab: no session token in localStorage gives a clear error and closes the window', async () => {
  const { page, dialogs, grab } = await sfxPage('abc', null);
  const [viewer] = await Promise.all([page.waitForEvent('popup'), grab()]);
  await page.waitForTimeout(500);
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0], /no SignalFx session token/);
  assert.ok(viewer.isClosed());
  await page.close();
});

test('sfx-grab: silent viewer leads to a message about the saved file', async () => {
  const { page, dialogs, grab } = await sfxPage('abc');
  await page.evaluate(v => { window.SFX_GRAB = { viewerUrl: v, readyTimeoutMs: 300 }; }, `${base}/test/fake-sfx.html`);
  const [popup] = await Promise.all([page.waitForEvent('popup'), grab()]);
  await page.waitForTimeout(800);
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0], /trace-abc\.json/);
  await popup.close(); await page.close();
});

test('sfx-grab: opens the window before the first API request (popup blocker)', async () => {
  const { page, grab } = await sfxPage('abc');
  await page.evaluate(() => {
    window.__order = [];
    const open = window.open, f = window.fetch;
    window.open = (...a) => (window.__order.push('open'), open.apply(window, a));
    window.fetch = (...a) => (window.__order.push('fetch'), f.apply(window, a));
  });
  const [viewer] = await Promise.all([page.waitForEvent('popup'), grab()]);
  await viewer.waitForFunction(() => window.__viewer?.S.spans.length > 0);
  assert.equal(await page.evaluate(() => window.__order[0]), 'open');
  await viewer.close(); await page.close();
});

test('?from=sfx: accepts a trace only once', async () => {
  const { page } = await openSfx();
  const spans = (await traceJson()).spans;
  await page.evaluate(spans => {
    window.postMessage({ type: 'sfx-trace', name: 'a', data: { traceId: 'first', spans: spans.slice(0, 50) } }, '*');
    setTimeout(() => window.postMessage({ type: 'sfx-trace', name: 'b', data: { traceId: 'second', spans: spans.slice(0, 20) } }, '*'), 100);
  }, spans);
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => window.__viewer.S.traceId), 'first');
  await page.close();
});
