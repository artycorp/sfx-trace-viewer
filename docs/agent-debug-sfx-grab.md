# Fixing `sfx-grab.js` against a real SignalFx instance

You are an agent on the human's remote machine, on branch `feat/open-in-viewer`. Your job: make
`extension/sfx-grab.js` fetch the open trace from the human's real SignalFx and open it in the viewer,
with no manual config. Work **evidence first**: every code change follows from a fact the human showed you.

## What the code does today

`extension/sfx-grab.js` runs in the SignalFx page (pasted into DevTools console, or injected by the
extension in `extension/` via `chrome.scripting.executeScript`, `world: 'MAIN'`). It:

1. takes `traceId` from `location.hash` (`#/apm/traces/<id>`) and opens the viewer window right away
   (popups are allowed only for a few seconds after the click, so keep `window.open` before the first `await`);
2. fetches `${apiBase}/v2/apm/trace/${traceId}/segments`, then every segment in parallel, dedupes by
   `spanId ?? id`, saves `trace-<id>.json` to Downloads;
3. asks `confirm`, then posts `{type: 'sfx-trace', name, data}` to the viewer after it sends `{type: 'sfx-viewer-ready'}`.

Defaults: `apiBase = location.origin`, `credentials: 'include'`, `headers = {}`. Overrides: `window.SFX_GRAB`.

## What is known

- With the defaults the human gets: `SignalFx → viewer: HTTP 401, not authorized: log in to SignalFx or set SFX_GRAB.headers`.
- The SignalFx UI's own API requests carry an `X-SF-Token` header (auth is a header, not cookies).
- Unknown: the API host the UI calls, where the page keeps the token, whether the API's CORS accepts
  `credentials: 'include'`, the response shape of `/segments` and of a segment.

## Rules

- You cannot see the human's SignalFx session. Get facts by giving the human a console snippet to run and
  asking them to paste the output.
- Never ask for, print, log, commit or put in a test a token value. Snippets you give the human mask
  values (`<N chars>`); you only ever see header names, storage key names and URLs without query strings.
- Code, comments, strings and test names in English. Chat with the human in Russian.
- Keep `trace_viewer.html` a single offline file; add no dependencies.

## Steps

### 1. Collect evidence

Ask the human to run this on the trace page and paste the JSON:

```js
(() => {
  const mask = v => `<${String(v).length} chars>`;
  const keys = s => Object.keys(s).filter(k => /token|auth|session|sf|access/i.test(k)).map(k => `${k}: ${mask(s.getItem(k))}`);
  const out = {
    origin: location.origin,
    hash: location.hash,
    apiCalls: [...new Set(performance.getEntriesByType('resource').map(e => e.name)
      .filter(u => /\/v2\/|apm|trace/i.test(u)).map(u => u.replace(/[?#].*/, '')))].slice(0, 30),
    localStorage: keys(localStorage),
    sessionStorage: keys(sessionStorage),
    cookieNames: document.cookie.split(';').map(c => c.split('=')[0].trim()).filter(Boolean),
  };
  console.log(JSON.stringify(out, null, 2));
  return out;
})();
```

Also ask: in DevTools → Network, on the request made by «Download Trace», the Request URL without query,
the request header **names**, and the response status.

Done when you know the API host and path the UI uses for trace segments, and which storage key (or other
source) holds the `X-SF-Token` value. If no storage key looks like the token, ask the human to check
which key's masked length equals the length of the `X-SF-Token` value in Network.

### 2. Confirm the hypothesis by hand

Have the human run, with values from Network, then click the extension icon:

```js
window.SFX_GRAB = { viewerUrl: 'http://localhost:8099/trace_viewer.html',
  apiBase: 'https://<host>', headers: { 'X-SF-Token': '<value>' } };
```

(`python3 -m http.server 8099` in the repo serves the viewer until the branch is merged to `main`.)

- Trace opens → hypothesis holds, go to 3.
- `Failed to fetch` → CORS rejects `credentials: 'include'`; that option goes in step 3.
- 401 / 404 → wrong path or host; back to 1 with the full Request URL.

Done when the trace opened in the viewer with the span count SignalFx shows.

### 3. Automate it

In `extension/sfx-grab.js`, derive the defaults from what step 1 found: `apiBase` from the UI's own API
host (e.g. the host of the first matching `performance` resource entry, or a mapping from
`location.origin`), `X-SF-Token` from the storage key found, `credentials` as step 2 showed. Explicit
`window.SFX_GRAB` values still win. When the token is not found, fail with a message that says what to set.

Test first, in `test/viewer.test.mjs`: extend `fakeSfxApi` so it answers 401 unless the request carries
`X-SF-Token` equal to a value the test page put in the same storage key; the test sets that key, runs the
snippet with no `SFX_GRAB.headers`, and asserts the viewer loads all spans. Watch it fail, then implement.

Run `npm test` (setup once: `npm install && npx playwright install chromium-headless-shell`).
Done when `npm test` is all green and the human confirms one click on the extension opens a real trace
with no `SFX_GRAB` set.

### 4. Hand back

Commit on `feat/open-in-viewer`; push only when the human says so. Update the «Вариант В» section of
`README.md` (Russian) if the setup changed. Report to the human: what the evidence showed, what you changed,
the `npm test` result, and anything still unknown (e.g. SSO redirect behaviour on an expired session).
