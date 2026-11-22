#!/usr/bin/env bash
# ============================================================================
# Оновлення ЛИШЕ карти на сервері однією командою (код гри не чіпає).
#   1. Експортуй карту з редактора (файл tileweaver_....json) і завантаж у домашню папку сервера (UPLOAD FILE).
#   2. Запусти:   bash ~/stalker-mmo/scripts/map-update.sh
#      (бере НАЙНОВІШИЙ ~/tileweaver_*.json; або вкажи файл:  bash ~/stalker-mmo/scripts/map-update.sh ~/мій.json)
# Що робить: збирає карту (картинки, колізії, будинки), друкує ПОПЕРЕДЖЕННЯ і перезапускає гру.
# Якщо збірка знайшла помилку — файли гри не змінюються, гра працює зі старою картою.
# ============================================================================
set -e
DIR="${ZONA_DIR:-$HOME/stalker-mmo}"
SRC="${1:-}"
[ -n "$SRC" ] || SRC=$(ls -t "$HOME"/tileweaver_*.json 2>/dev/null | head -1 || true)
[ -n "$SRC" ] && [ -f "$SRC" ] || { echo "Нема файлу карти. Завантаж tileweaver_....json у домашню папку (UPLOAD FILE)."; exit 1; }
cd "$DIR"
echo "Карта: $SRC"
node scripts/build-map.mjs "$SRC"
cp "$SRC" map-src/map.json
if command -v pm2 >/dev/null && pm2 describe zona >/dev/null 2>&1; then
  pm2 restart zona --update-env >/dev/null
  echo "Гру перезапущено. Онови сторінку в браузері."
else
  echo "Карту зібрано. Перезапусти гру вручну (pm2 restart zona)."
fi
