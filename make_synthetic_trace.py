#!/usr/bin/env python3
"""
make_synthetic_trace.py — синтетический часовой трейс в формате SignalFx
"Download APM traces" API (startTime ISO + durationMicros), для разработки
и тестов trace_viewer.html без доступа к реальному SignalFx.

Структура:
  * фон: каждые 2–5 минуты короткие операции (по 3–8 спанов) — «часовой трейс»;
  * T+15min: средняя операция «monthly-report» ~2 минуты, ~300 спанов;
  * T+40min: ГЛАВНОЕ — операция «GET /report/export» длительностью 12 секунд,
    ~2800 спанов: слои api -> service -> repo, N+1 по DB, ретраи, внешний
    вызов 8s, медленный SQL 3.5s.

Выход: trace.json (совместим с trace_viewer.html и download_trace.py).
"""
import json
import random
import sys
from datetime import datetime, timedelta, timezone

random.seed(20261117)

TRACE_ID = 'a1b2c3d4e5f67081'
T0 = datetime(2026, 11, 16, 14, 0, 0, tzinfo=timezone.utc)

spans = []
_id = [0x1000]


def new_id():
    _id[0] += 1
    return format(_id[0], '016x')


def iso(dt):
    s = dt.isoformat(timespec='milliseconds')
    return s.replace('+00:00', 'Z')


def span(parent, service, op, start, dur_ms, tags=None, kind='SERVER'):
    s = {
        'type': 'span',
        'traceId': TRACE_ID,
        'spanId': new_id(),
        'parentId': parent if parent else '',
        'serviceName': service,
        'operationName': op,
        'startTime': iso(start),
        'durationMicros': int(dur_ms * 1000),
        'tags': dict(tags or {}),
        'processTags': {},
        'logs': [],
        'splunk': {},
    }
    s['tags'].setdefault('span.kind', kind)
    spans.append(s)
    return s['spanId']


def op_background(root_start):
    """Фоновая короткая операция: api -> auth + db."""
    root = span(None, 'frontend', 'GET /api/status', root_start, random.uniform(8, 40),
                {'http.method': 'GET', 'http.status_code': '200'})
    t = root_start + timedelta(milliseconds=1)
    span(root, 'auth-service', 'verify-token', t, random.uniform(1, 6), kind='CLIENT')
    span(root, 'postgres', 'SELECT 1', t + timedelta(milliseconds=2), random.uniform(0.4, 3),
         {'db.system': 'postgresql', 'db.statement': 'SELECT 1'}, kind='CLIENT')


def op_medium(root_start):
    """Средняя операция ~2 минуты: генерация monthly report, ~300 спанов."""
    root = span(None, 'frontend', 'POST /api/reports/monthly', root_start, 120_000,
                {'http.method': 'POST', 'http.status_code': '200'})
    t = root_start
    gen = span(root, 'report-service', 'generate-monthly', t + timedelta(milliseconds=3), 119_500, kind='SERVER')
    for i in range(60):  # 60 кусков по ~2s, в каждом пачка спанов
        t = t + timedelta(seconds=2)
        chunk = span(gen, 'report-service', f'render-chunk/{i}', t, 1_900, kind='INTERNAL')
        span(chunk, 'postgres', 'SELECT * FROM billing_rows', t, random.uniform(120, 480),
             {'db.system': 'postgresql'}, kind='CLIENT')
        span(chunk, 'pdf-renderer', 'draw-page', t + timedelta(milliseconds=500), random.uniform(200, 900), kind='CLIENT')
    span(root, 's3', 'PUT report.pdf', root_start + timedelta(seconds=119), 700, kind='CLIENT')


def op_main(root_start, parent=None):
    """ГЛАВНАЯ операция: 12 секунд, ~2800 спанов."""
    root = span(parent, 'frontend', 'GET /report/export', root_start, 12_000,
                {'http.method': 'GET', 'http.status_code': '200', 'tenant-level': 'gold'})
    t = root_start + timedelta(milliseconds=2)

    # слой 1: сервисные вызовы
    agg = span(root, 'report-service', 'aggregate', t, 11_500, kind='SERVER')
    ext = span(root, 'partner-api', 'GET /v2/scores', t, 8_000,
               {'http.url': 'https://partner.example/v2/scores', 'http.status_code': '200'}, kind='CLIENT')
    # внутри partner-api: 3 ретрая по ~2.6s
    rt = t + timedelta(milliseconds=50)
    for attempt in range(3):
        code = '503' if attempt < 2 else '200'
        span(ext, 'partner-api', f'attempt/{attempt + 1}', rt, 2_600,
             {'http.status_code': code, 'retry': str(attempt)}, kind='CLIENT')
        rt = rt + timedelta(milliseconds=2_650)

    # слой 2: aggregate -> 40 групп, в каждой N+1 по DB
    for g in range(40):
        gt = t + timedelta(milliseconds=200 + g * 270)
        grp = span(agg, 'report-service', f'group/{g:02d}/load', gt, 250, kind='INTERNAL')
        span(grp, 'postgres', 'SELECT * FROM groups WHERE id=$1', gt, random.uniform(2, 9),
             {'db.system': 'postgresql', 'db.statement': 'SELECT * FROM groups WHERE id=$1'}, kind='CLIENT')
        # N+1: 60 запросов по ~0.3–1.2ms
        nt = gt + timedelta(milliseconds=10)
        for n in range(60):
            d = random.uniform(0.3, 1.2)
            span(grp, 'postgres', 'SELECT * FROM rows WHERE group_id=$1', nt, d,
                 {'db.system': 'postgresql',
                  'db.statement': 'SELECT * FROM rows WHERE group_id=$1'}, kind='CLIENT')
            nt = nt + timedelta(milliseconds=d + random.uniform(0.05, 0.25))
        span(grp, 'redis', 'CACHE GET', gt + timedelta(milliseconds=120), random.uniform(0.2, 1.5), kind='CLIENT')

    # медленный SQL на 3.5s
    span(agg, 'postgres', 'SELECT ... GROUP BY tenant ORDER BY ...', 
         t + timedelta(milliseconds=7_800), 3_500,
         {'db.system': 'postgresql', 'db.statement': 'SELECT sum(amount) ... GROUP BY tenant'}, kind='CLIENT')

    # финализация
    fin = t + timedelta(milliseconds=11_400)
    span(root, 'report-service', 'serialize-json', fin, 400, kind='INTERNAL')
    span(root, 'frontend', 'write-response', fin + timedelta(milliseconds=410), 150, kind='INTERNAL')


FE_PROC = {'telemetry.sdk.language': 'webjs', 'service.name': 'web-ui'}


def fe_span(parent, op, start, dur_ms, tags=None, kind='CLIENT'):
    """Спан браузерного SDK: ресурсные атрибуты в processTags, как в выгрузке SignalFx."""
    sid = span(parent, 'web-ui', op, start, dur_ms, tags, kind=kind)
    spans[-1]['processTags'] = dict(FE_PROC)
    return sid


def op_browser(page_start):
    """Страница в браузере (~14s) вокруг главной операции — все варианты подсветки FE/backend:
       ok   — fetch /report/export: 12.3s, бэкенд 12s (разрыв ~2%)        -> без подсветки
       warn — fetch /api/user: 900ms, бэкенд 350ms (61%, 550ms)           -> жёлтый
       bad  — fetch /api/catalog: 2.4s, 2 параллельных бэкенда, вместе 300ms -> красный
       ok   — click "Найти" > fetch /api/search: 1.7s, бэкенд 1.2s (29%)  -> без подсветки
       none — fetch https://cdn.partner.example/...: бэкенда в трейсе нет -> серая рамка
    Возвращает (fetch_export_id, его старт) — под него вешается op_main."""
    ms = lambda x: timedelta(milliseconds=x)
    page = fe_span(None, 'documentLoad /reports', page_start, 14_500,
                   {'location.href': 'https://app.example/reports'}, kind='INTERNAL')

    # warn: сеть съела 550ms из 900ms
    u = fe_span(page, 'HTTP GET /api/user', page_start + ms(100), 900,
                {'http.method': 'GET', 'http.url': 'https://app.example/api/user', 'http.status_code': '200'})
    us = span(u, 'frontend', 'GET /api/user', page_start + ms(400), 350, {'http.status_code': '200'})
    span(us, 'auth-service', 'verify-token', page_start + ms(410), 40, kind='CLIENT')

    # bad: 2.4s, бэкенд два параллельных запроса (объединение ~300ms, не 500)
    c = fe_span(page, 'HTTP GET /api/catalog', page_start + ms(150), 2_400,
                {'http.method': 'GET', 'http.url': 'https://app.example/api/catalog', 'http.status_code': '200'})
    span(c, 'frontend', 'GET /api/catalog', page_start + ms(1_900), 250, {'http.status_code': '200'})
    span(c, 'catalog-service', 'GET /catalog/items', page_start + ms(1_950), 250, {'http.status_code': '200'})

    # FE-обёртка над FE: разрыв считается по серверным спанам внутри вложенного fetch
    srch = fe_span(page, 'click "Найти"', page_start + ms(3_000), 1_800, kind='INTERNAL')
    f = fe_span(srch, 'HTTP GET /api/search', page_start + ms(3_050), 1_700,
                {'http.method': 'GET', 'http.url': 'https://app.example/api/search', 'http.status_code': '200'})
    span(f, 'frontend', 'GET /api/search', page_start + ms(3_300), 1_200, {'http.status_code': '200'})

    # none: сторонний домен, traceparent не уходит (CORS) -> бэкенда в трейсе нет
    fe_span(page, 'HTTP GET https://cdn.partner.example/widget.js', page_start + ms(200), 650,
            {'http.method': 'GET', 'http.url': 'https://cdn.partner.example/widget.js', 'http.status_code': '200'})

    # ok: экспорт — почти всё время на бэкенде
    exp_start = page_start + ms(1_000)
    exp = fe_span(page, 'HTTP GET /report/export', exp_start, 12_300,
                  {'http.method': 'GET', 'http.url': 'https://app.example/report/export', 'http.status_code': '200'})
    return exp, exp_start


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else 'trace.json'

    # фон: каждые 2–5 минут весь час
    t = T0
    while t < T0 + timedelta(hours=1):
        op_background(t)
        t = t + timedelta(seconds=random.uniform(120, 300))

    op_medium(T0 + timedelta(minutes=15))
    # главная 12-сек операция в 14:40, вызвана из браузера (страница стартует на 1s раньше)
    exp, exp_start = op_browser(T0 + timedelta(minutes=40) - timedelta(milliseconds=1_150))
    op_main(exp_start + timedelta(milliseconds=150), parent=exp)

    spans.sort(key=lambda s: s['startTime'])
    data = {
        'traceId': TRACE_ID,
        'segments': [int((T0.timestamp()) * 1000)],
        'spans': spans,
        'synthetic': True,
        'note': 'hour-long synthetic trace; dense 12s op "GET /report/export" at 14:40',
    }
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False)
    print(f'{out}: {len(spans)} spans, traceId={TRACE_ID}, '
          f'окно 14:00–15:00 UTC, 12s операция в 14:40')


if __name__ == '__main__':
    main()
