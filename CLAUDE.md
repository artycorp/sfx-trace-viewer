# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`../AGENTS.md` (Warehouse Service, Spring Boot) описывает другой проект и здесь не применяется.

## Команды

```bash
npm install && npx playwright install chromium-headless-shell   # один раз
npm test                                         # все тесты (node:test + Playwright)
node --test --test-name-pattern="self time" test/viewer.test.mjs  # один тест по имени
python3 -m http.server 8099                      # ручной просмотр: http://localhost:8099/trace_viewer.html
python3 make_synthetic_trace.py                  # перегенерировать trace.json
```

Сборки, линтера и бандлера нет.

## Архитектура

- `trace_viewer.html` — весь UI в одном файле (CSS + один `<script>`), без внешних зависимостей: должен открываться через `file://` и оффлайн. Свой трейс пользователь перетаскивает на страницу, данные не уходят из браузера.
  - Единое состояние — объект `S` (спаны, `byId`, `children`, окно `winStart/winEnd`, фильтры, фокус, collapsed). Поток: `loadTrace` → `normSpans` (приводит формат Download APM API и zipkin-подобный к общему виду; единицы времени угадываются по величине) → предрасчёты (`computeSelf`, `computeFeGaps`, `tagIdx` для автодополнения) → `setWindow` → `renderAll` / `renderAnalysis`.
  - `window.__viewer` — тестовый хук, через него тесты читают `S` и вызывают функции. Переименование функций или полей `S` ломает тесты.
- `test/viewer.test.mjs` — поднимает свой статический сервер (как GitHub Pages) и гоняет страницу в headless Chromium на `trace.json`.
- `trace.json` — закоммиченный демо-трейс от `make_synthetic_trace.py` (`random.seed` фиксирован). Тесты завязаны на конкретные spanId (`0000000000001034` и т.п.) и числа (self корня ≈303 мс, повторы ×60): правка генератора меняет `trace.json` и может уронить тесты.
- `download_trace.py` — только stdlib: скачивание сегментов через API SignalFx (перебор хостов по realm или `--api-base`) и `--merge` сегментов из UI с дедупликацией. Токен: env `SF_ACCESS_TOKEN` → файл `.token` → `--token`.
- `extension/sfx-grab.js` — сниппет для консоли на странице трейса SignalFx: сегменты через API под сессией пользователя → `trace-<id>.json` в «Загрузки» → вьюер `?from=sfx`. Протокол: вьюер шлёт `{type:'sfx-viewer-ready'}` в `opener` и в `window`, принимает `{type:'sfx-trace', name, data}` только от них. На нём же будет расширение (см. `docs/superpowers/specs/2026-11-20-open-in-viewer-design.md`).
- `index.html` — редирект для GitHub Pages, сохраняет `location.hash` (`#span=…`).

README.md — пользовательская документация на русском; новые возможности UI описываются там же.
