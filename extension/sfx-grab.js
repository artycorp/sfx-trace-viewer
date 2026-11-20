// Sends the SignalFx trace open in this tab to SFX Trace Viewer. Paste into DevTools console on …/#/apm/traces/<traceId>.
// Optional settings, set before running: window.SFX_GRAB = { apiBase, viewerUrl, headers, readyTimeoutMs }.
(async () => {
  const cfg = {
    apiBase: location.origin,
    viewerUrl: 'https://artycorp.github.io/sfx-trace-viewer/trace_viewer.html',
    readyTimeoutMs: 15000,
    ...window.SFX_GRAB,
  };
  const fail = msg => alert('SignalFx → viewer: ' + msg);
  const traceId = location.hash.match(/traces\/([0-9a-f]+)/i)?.[1];
  if (!traceId) return fail('open a trace page first: …/#/apm/traces/<traceId>');

  // open before the first await: the browser allows popups only for a few seconds after the user gesture
  const win = window.open(cfg.viewerUrl + '?from=sfx');
  let ready = false, onReady = () => {};
  window.addEventListener('message', function listen(e) {
    if (e.source !== win || e.data?.type !== 'sfx-viewer-ready') return;
    window.removeEventListener('message', listen);
    ready = true;
    onReady();
  });

  let spans;
  try {
    // the SignalFx UI authorizes with the X-SF-Token header and keeps its value in localStorage['X-SF-TOKEN']
    let headers = cfg.headers;
    if (headers === undefined) {
      let token;
      try { token = localStorage.getItem('X-SF-TOKEN'); } catch {}
      if (!token) throw new Error('no SignalFx session token found: log in to SignalFx or set SFX_GRAB.headers');
      headers = { 'X-SF-Token': token };
    }
    const get = async seg => {
      const r = await fetch(`${cfg.apiBase}/v2/apm/trace/${traceId}/${seg}`, { credentials: 'include', headers });
      if (r.status === 401 || r.status === 403) {
        throw new Error(`HTTP ${r.status}, not authorized: log in to SignalFx or set SFX_GRAB.headers`);
      }
      if (!r.ok) throw new Error(`HTTP ${r.status} at ${r.url}`);
      return r.json();
    };
    const parts = await Promise.all((await get('segments')).map(get));
    const seen = new Set();
    spans = [];
    for (const part of parts) {
      for (const s of Array.isArray(part) ? part : part.spans || []) {
        const k = s.spanId ?? s.id ?? JSON.stringify(s);
        if (!seen.has(k)) { seen.add(k); spans.push(s); }
      }
    }
  } catch (err) {
    win?.close();
    return fail(err.message);
  }

  const data = { traceId, spans }, name = `trace-${traceId}.json`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);

  const saved = `The trace is saved to Downloads as ${name}: drop it onto ${cfg.viewerUrl}`;
  if (!win) return fail(`the browser blocked the viewer window. ${saved}`);
  if (win.closed) return fail(`lost the connection to the viewer window. ${saved}`);

  const send = () => win.postMessage({ type: 'sfx-trace', name, data }, new URL(cfg.viewerUrl).origin);
  if (ready) return send();
  const timer = setTimeout(() => fail(`the viewer did not respond. ${saved}`), cfg.readyTimeoutMs);
  onReady = () => { clearTimeout(timer); send(); };
})();
