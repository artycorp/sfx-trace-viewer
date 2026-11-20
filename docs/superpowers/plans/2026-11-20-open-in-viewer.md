# «Открыть во вьюере» — этап 1. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** вьюер принимает трейс от другой вкладки по `postMessage`, а сниппет для консоли DevTools на странице SignalFx выгружает трейс и открывает его во вьюере.

**Architecture:** протокол `sfx-viewer-ready` / `sfx-trace` в `trace_viewer.html`; сниппет `extension/sfx-grab.js` — обычный скрипт без модулей (вставляется в консоль, на этапе 2 станет content script). Сквозной тест гоняет сниппет против поддельного API SignalFx на тестовом сервере.

**Tech Stack:** ванильный JS, node:test + Playwright (уже в проекте).

**Spec:** `docs/superpowers/specs/2026-11-20-open-in-viewer-design.md`

## Global Constraints

- Без новых зависимостей; вьюер остаётся одним файлом, работающим оффлайн.
- Трейс не уходит в сеть никуда, кроме SignalFx; в URL трейс не кладётся.
- `VIEWER_URL` по умолчанию: `https://artycorp.github.io/sfx-trace-viewer/trace_viewer.html`.
- Эндпоинты-ориентиры: `${apiBase}/v2/apm/trace/${traceId}/segments` → массив id сегментов; `${apiBase}/v2/apm/trace/${traceId}/${segment}` → массив спанов или `{spans}`.
- Дедупликация по `spanId ?? id` (как `dedupe` в `download_trace.py`).

## Review Focus

1. Сообщение `sfx-trace` от чужого окна (не `opener` и не сама страница) — игнорируется. → тест в Task 1.
2. `sfx-trace` с мусором в `data` — `alert` с ошибкой, страница не падает (`pageerror` пуст). → тест в Task 1.
3. Один и тот же спан в двух сегментах — во вьюере один раз. → тест в Task 2.
4. API вернул 401/403 — понятная ошибка «войди в SignalFx / проверь авторизацию», вьюер не открывается. → тест в Task 2.
5. Браузер заблокировал всплывающее окно (`window.open` → `null`) — сообщение пользователю, файл в «Загрузках» уже есть. → проверка вручную в Task 3 (в Playwright блокировку не воспроизвести).

---

### Task 1: вьюер принимает трейс по postMessage

**Files:**
- Modify: `trace_viewer.html` (блок `autoload` в конце `<script>`)
- Test: `test/viewer.test.mjs`

**Interfaces:**
- Produces: с `?from=sfx` вьюер не грузит демо, шлёт `{type:'sfx-viewer-ready'}` в `window.opener` (если есть) и в `window`; на `message` с `e.data.type === 'sfx-trace'` и `e.source ∈ {window.opener, window}` вызывает `loadTrace(e.data.data, e.data.name)`, ошибки — `alert`.

- [ ] **Step 1: тесты** в `test/viewer.test.mjs`:
  - `'?from=sfx: принимает трейс по postMessage, демо не грузит'` — открыть `trace_viewer.html?from=sfx` (без ожидания спанов: `open()` ждёт загрузки — нужна вариация без `waitForFunction`), проверить `S.spans.length === 0`, затем `page.evaluate` с `window.postMessage({type:'sfx-trace', name:'x', data: {traceId:'t1', spans:[…первые 50 спанов trace.json…]}}, '*')` → `S.spans.length === 50`, `S.traceId === 't1'`, `errors` пуст.
  - `'?from=sfx: сообщение из чужого окна игнорируется'` — из iframe (`srcdoc`) отправить `parent.postMessage(...)` → `S.spans.length === 0`.
  - `'?from=sfx: битые данные — alert, без падения'` — `data: 42`; `page.on('dialog')` поймал диалог, `errors` пуст.
- [ ] **Step 2:** `npm test` — новые тесты FAIL (демо загрузилось / спанов нет).
- [ ] **Step 3:** реализовать в `autoload` ветку `from=sfx` по Interfaces.
- [ ] **Step 4:** `npm test` — все PASS.
- [ ] **Step 5:** commit `feat(viewer): приём трейса по postMessage (?from=sfx)`.

### Task 2: сниппет `extension/sfx-grab.js` + сквозной тест

**Files:**
- Create: `extension/sfx-grab.js`
- Create: `test/fake-sfx.html` (пустая страница «SignalFx»)
- Modify: `test/viewer.test.mjs` (маршруты поддельного API на тестовом сервере)

**Interfaces:**
- Consumes: протокол из Task 1.
- Produces: скрипт, запускаемый целиком (`(async () => {...})()`), конфиг из `window.SFX_GRAB = {apiBase?, viewerUrl?, headers?}`:
  - `apiBase` по умолчанию — `location.origin` (уточнится в Task 3);
  - `traceId` — из `location.hash` по `/traces\/([0-9a-f]+)/i`, нет — `alert` и выход;
  - `fetch` с `credentials: 'include'` и `headers`; не-2xx → `throw` с текстом про авторизацию для 401/403;
  - склейка + дедупликация → `{traceId, spans}`;
  - скачивание `trace-${traceId}.json` (Blob + `<a download>`);
  - `confirm(\`Открыть трейс ${traceId} (${n} спанов) во вьюере?\`)` → `window.open(viewerUrl + '?from=sfx')`; `null` → `alert('Браузер заблокировал окно…')`;
  - ждёт `sfx-viewer-ready` с `e.source === win`, затем `win.postMessage({type:'sfx-trace', name, data}, '*')`.

- [ ] **Step 1: тест-сервер** — маршрут `/v2/apm/trace/:id/segments` → `["s1","s2"]`; `/v2/apm/trace/:id/s1` и `/s2` → две половины спанов `trace.json` с перекрытием в 10 спанов; trace id `bad` → 401.
- [ ] **Step 2: тесты:**
  - `'sfx-grab: склеивает сегменты без дублей и открывает вьюер'` — открыть `test/fake-sfx.html#/apm/traces/abc`, `SFX_GRAB = {viewerUrl: base + '/trace_viewer.html'}`, принимать `confirm`, `page.addScriptTag({path: 'extension/sfx-grab.js'})`, дождаться `context.waitForEvent('page')` → во вкладке `S.spans.length` равно числу уникальных спанов `trace.json`; скачивание `trace-abc.json` пойманно (`page.waitForEvent('download')`).
  - `'sfx-grab: 401 — ошибка про авторизацию, вьюер не открыт'` — `#/apm/traces/bad` → `alert` содержит «автори», новых вкладок нет.
- [ ] **Step 3:** `npm test` — FAIL (файла нет).
- [ ] **Step 4:** написать `extension/sfx-grab.js` по Interfaces.
- [ ] **Step 5:** `npm test` — все PASS.
- [ ] **Step 6:** README — раздел «Открыть из SignalFx (консоль)»: как вставить сниппет; CLAUDE.md — строка про `extension/` и протокол. Commit `feat: сниппет sfx-grab для выгрузки трейса из SignalFx`.

### Task 3: проверка на настоящем SignalFx (вручную, с пользователем)

- [ ] Пользователь открывает трейс в SignalFx, DevTools → Network, жмёт «Download Trace» и сообщает: URL запросов, заголовки авторизации (без значений токена), форму ответа.
- [ ] Поправить умолчания `apiBase`/`headers` в `sfx-grab.js` под найденное (например, токен сессии из `localStorage` → `X-SF-Token`), тест Task 2 обновить под форму, если она другая.
- [ ] Пользователь запускает сниппет: вьюер открылся, число спанов = числу в SignalFx; при заблокированном окне — сообщение, файл в «Загрузках».
- [ ] Записать домен SignalFx в спеку (нужен для `host_permissions` на этапе 2). Commit.

Этап 2 (расширение) — отдельный план после Task 3.
