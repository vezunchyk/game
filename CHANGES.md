# render-v9: нове ядро малювання (зміни відносно v8)

Змінені файли:
- client/render/MapRenderer.ts — переписано: групи -> (z, y) -> персонаж за y ніг; будинок = група з редактора; прозорість по поверхах.
- client/main.ts — drawDebug отримує глядача (ромби будинку в ?debug).
- scripts/build-map.mjs — шар -> група лише з render-rules.json (без flat/isRoof); поле будинку `houses` у map.json (format 7);
  глибина (sy) перемичок від дверей/стіни того ж поверху; прибрано дублі розміщень і однакові колізії; звіт збірки (32 розміщення без картинок).
- map-src/render-rules.json — по рядку на шар: ground / floor N / roof; flatKinds прибрано.
- tests/render.test.ts — переписано під нове ядро (10 груп перевірок).
- public/assets/map.json, data/server-map.json, public/assets/debug-collisions.json — перезбрані.
- README.md, scripts/build.mjs (мітка збірки render-v9).

Не чіпано: колізії стін і кутів (баг 2), рух по сходах, сервер, протокол.
