// Выгрузка открытого трейса SignalFx во вьюер. Вставить в консоль DevTools на странице …/#/apm/traces/<traceId>.
// Настройки (необязательно, задать до запуска): window.SFX_GRAB = { apiBase, viewerUrl, headers }.
(async () => {
  const cfg = {
    apiBase: location.origin,
    viewerUrl: 'https://artycorp.github.io/sfx-trace-viewer/trace_viewer.html',
    headers: {},
    readyTimeoutMs: 15000,
    ...window.SFX_GRAB,
  };
  try {
    const traceId = location.hash.match(/traces\/([0-9a-f]+)/i)?.[1];
    if (!traceId) throw new Error('открой страницу трейса: …/#/apm/traces/<traceId>');
    const get = async seg => {
      const r = await fetch(`${cfg.apiBase}/v2/apm/trace/${traceId}/${seg}`, { credentials: 'include', headers: cfg.headers });
      if (r.status === 401 || r.status === 403) {
        throw new Error(`HTTP ${r.status} — нет авторизации: войди в SignalFx или задай SFX_GRAB.headers`);
      }
      if (!r.ok) throw new Error(`HTTP ${r.status} на ${r.url}`);
      return r.json();
    };

    const seen = new Set(), spans = [];
    for (const seg of await get('segments')) {
      const part = await get(seg);
      for (const s of Array.isArray(part) ? part : part.spans || []) {
        const k = s.spanId ?? s.id ?? JSON.stringify(s);
        if (!seen.has(k)) { seen.add(k); spans.push(s); }
      }
    }
    const data = { traceId, spans }, name = `trace-${traceId}.json`;

    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);

    if (!confirm(`Открыть трейс ${traceId} (${spans.length} спанов) во вьюере?`)) return;
    const win = window.open(cfg.viewerUrl + '?from=sfx');
    if (!win) throw new Error(`браузер заблокировал окно. Трейс сохранён в «Загрузки» (${name}) — перетащи его на ${cfg.viewerUrl}`);
    const timer = setTimeout(() => {
      window.removeEventListener('message', onReady);
      alert(`SignalFx → вьюер: вьюер не ответил. Трейс сохранён в «Загрузки» (${name}) — перетащи его на открывшуюся страницу`);
    }, cfg.readyTimeoutMs);
    function onReady(e) {
      if (e.source !== win || e.data?.type !== 'sfx-viewer-ready') return;
      clearTimeout(timer);
      window.removeEventListener('message', onReady);
      win.postMessage({ type: 'sfx-trace', name, data }, new URL(cfg.viewerUrl).origin);
    }
    window.addEventListener('message', onReady);
  } catch (err) {
    alert('SignalFx → вьюер: ' + err.message);
  }
})();
