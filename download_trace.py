#!/usr/bin/env python3
"""
download_trace.py — скачать трейс из Splunk SignalFx APM (Observability Cloud).

Способы:
  1) API (org access token или session token):
       SF_ACCESS_TOKEN=xxx python3 download_trace.py --trace-id <ID> [--realm us0]
     Токен также можно положить в файл .token рядом со скриптом.
     Скачивает ВСЕ сегменты трейса и склеивает их в один trace.json.
  2) Файлы из UI: python3 download_trace.py --merge seg1.json seg2.json -o trace.json
     (seg*.json — файлы из кнопки "Download Trace (N Segments)" в UI SignalFx)

Официальный API (https://dev.splunk.com/observability/docs/apm/download_traces):
  GET /v2/apm/trace/{traceId}/segments          -> [segmentTimestamp, ...] (ms)
  GET /v2/apm/trace/{traceId}/{segmentTimestamp} -> [{type:"span", ...}, ...]
  GET /v2/apm/trace/{traceId}/latest            -> последний сегмент
Хосты: api.<REALM>.observability.splunkcloud.com (текущий),
       api.<REALM>.signalfx.com (legacy, оставлен как fallback).
Заголовок авторизации: X-SF-Token.

Выход: trace.json вида {"traceId": ..., "segments": [...], "spans": [...]}
— формат понимает trace_viewer.html.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))

HOSTS = [
    'https://api.{realm}.observability.splunkcloud.com',
    'https://api.{realm}.signalfx.com',
]


def http_get(url, token, timeout=120):
    req = urllib.request.Request(url, headers={
        'X-SF-Token': token,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'sfx-trace-downloader/1.1',
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def pick_host(bases):
    """Вернёт первый base URL, который жив (отвечает 200/4xx)."""
    for base in bases:
        url = base + '/v2/apm/trace/healthcheck-ignored/segments'
        req = urllib.request.Request(url, headers={'X-SF-Token': 'x'})
        try:
            urllib.request.urlopen(req, timeout=20)
            return base  # маловероятно (ожидаем 4xx), но вдруг
        except urllib.error.HTTPError as e:
            if e.code in (400, 401, 403, 404, 429):
                return base  # хост жив, отвечает осмысленно
        except Exception:
            continue
    return bases[0]


def fetch_segments(trace_id, realm, token, api_base=None):
    if api_base:                       # свой сервер/прокси, напр. https://sfx-gw.corp
        bases = [api_base.rstrip('/')]
    else:
        bases = [h.format(realm=realm) for h in HOSTS]
    base = pick_host(bases)
    segs_url = f'{base}/v2/apm/trace/{trace_id}/segments'
    print(f'GET {segs_url}')
    segs = http_get(segs_url, token)
    if not isinstance(segs, list):
        raise SystemExit(f'Неожиданный ответ /segments: {json.dumps(segs)[:300]}')
    print(f'Сегментов: {len(segs)} -> {segs}')
    spans = []
    for ts in segs:
        url = f'{base}/v2/apm/trace/{trace_id}/{ts}'
        print(f'GET {url}')
        part = http_get(url, token)
        if isinstance(part, list):
            spans.extend(part)
            print(f'  +{len(part)} spans')
        elif isinstance(part, dict) and isinstance(part.get('spans'), list):
            spans.extend(part['spans'])
            print(f'  +{len(part["spans"])} spans')
        else:
            print(f'  ! пропущен сегмент {ts}: неизвестная форма ответа', file=sys.stderr)
        time.sleep(0.3)  # не душим API
    return segs, spans


def load_token(cli_token):
    if cli_token:
        return cli_token
    for var in ('SF_ACCESS_TOKEN', 'SPLUNK_ACCESS_TOKEN', 'SFX_ACCESS_TOKEN'):
        v = os.environ.get(var)
        if v:
            return v
    tf = os.path.join(HERE, '.token')
    if os.path.isfile(tf):
        with open(tf, encoding='utf-8') as f:
            v = f.read().strip()
        if v:
            return v
    return None


def dedupe(spans):
    seen, uniq = set(), []
    for s in spans:
        k = s.get('spanId') or s.get('id') or json.dumps(s, sort_keys=True)
        if k not in seen:
            seen.add(k)
            uniq.append(s)
    return uniq


def merge_files(paths):
    spans, trace_ids = [], set()
    for p in paths:
        with open(p, encoding='utf-8') as f:
            d = json.load(f)
        if isinstance(d, dict):
            if d.get('traceId'):
                trace_ids.add(str(d['traceId']))
            sp = d.get('spans', [])
        else:
            sp = d
        for s in sp:
            if isinstance(s, dict) and s.get('traceId'):
                trace_ids.add(str(s['traceId']))
        spans.extend(sp)
        print(f'{p}: +{len(sp)} spans')
    return {'traceId': next(iter(trace_ids), ''),
            'segments': len(paths),
            'spans': dedupe(spans),
            'merged_from': [os.path.basename(p) for p in paths]}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--trace-id')
    ap.add_argument('--realm', default=os.environ.get('SF_REALM', 'us0'),
                    help='realm организации: us0/us1/us2/eu0/eu1/ap0/ap1… — часть имени хоста app.<realm>.signalfx.com')
    ap.add_argument('--api-base', default=os.environ.get('SF_API_BASE'),
                    help='полный base URL своего сервера/прокси (перекрывает realm), напр. https://sfx-gw.corp.local')
    ap.add_argument('--token', help='access token (лучше env SF_ACCESS_TOKEN или файл .token)')
    ap.add_argument('--merge', nargs='+', help='склеить файлы сегментов из UI SignalFx')
    ap.add_argument('-o', '--out', default='trace.json')
    a = ap.parse_args()

    if a.merge:
        data = merge_files(a.merge)
    elif a.trace_id:
        token = load_token(a.token)
        if not token:
            raise SystemExit('Нужен токен: --token, env SF_ACCESS_TOKEN или файл .token рядом со скриптом')
        segs, spans = fetch_segments(a.trace_id, a.realm, token, a.api_base)
        data = {'traceId': a.trace_id, 'segments': segs,
                'spans': dedupe(spans), 'realm': a.realm}
    else:
        raise SystemExit('Укажи --trace-id или --merge (см. --help)')

    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False)
    print(f'Сохранено {a.out}: {len(data.get("spans", []))} уникальных спанов')
    print(f'Открой trace_viewer.html и перетащи {a.out} в окно '
          f'(или положи рядом и открой страницу через http-сервер).')


if __name__ == '__main__':
    main()
