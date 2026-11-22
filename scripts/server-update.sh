#!/usr/bin/env bash
# ============================================================================
# Встановлення / оновлення гри на Linux-сервері (Google Cloud VM) однією командою.
# Що робить: бере ~/stalker-mmo.zip, розпаковує, ставить залежності, збирає
# і (пере)запускає гру під pm2 (сама піднімається після перезавантаження VM).
#
# Використання: завантаж архів у домашню папку (кнопка UPLOAD FILE) і запусти
#   bash ~/stalker-mmo/scripts/server-update.sh        (або, вперше, див. README)
# Секрети (необов'язково): файл ~/zona.env з рядками
#   SUPABASE_URL=...
#   SUPABASE_SERVICE_KEY=...
# ============================================================================
set -e
ZIP="$HOME/stalker-mmo.zip"
DIR="$HOME/stalker-mmo"
[ -f "$ZIP" ] || { echo "Нема $ZIP. Завантаж архів кнопкою UPLOAD FILE."; exit 1; }

# 1. Потрібні програми (ставляться лише якщо їх немає)
command -v unzip >/dev/null || sudo apt-get install -y unzip
command -v npm >/dev/null || { sudo apt-get update -y && sudo apt-get install -y npm; }
command -v pm2 >/dev/null || sudo npm install -g pm2

# 2. Розпаковуємо поверх (node_modules і секрети не чіпаємо)
unzip -oq "$ZIP" -d "$HOME"
cd "$DIR"

# 3. Залежності і збірка
npm install --no-audit --no-fund
npm run build
grep -o "render-v[0-9]* [0-9: -]*" public/game.js | head -1 | sed "s/^/Клієнт зібрано: /"

# 4. Секрети з ~/zona.env (якщо є)
if [ -f "$HOME/zona.env" ]; then set -a; . "$HOME/zona.env"; set +a; fi
export PORT="${PORT:-7860}"

# 5. Запуск / перезапуск
if pm2 describe zona >/dev/null 2>&1; then
  pm2 restart zona --update-env
else
  pm2 start dist/server.js --name zona
  sudo env PATH="$PATH" pm2 startup systemd -u "$USER" --hp "$HOME" >/dev/null 2>&1 || true
fi
pm2 save >/dev/null

IP=$(curl -s -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip || true)
echo "Готово. Відкрий у браузері: http://${IP:-IP_СЕРВЕРА}:$PORT"
