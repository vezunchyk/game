#!/usr/bin/env bash
# ============================================================================
# Автооновлення сервера з GitHub. Запускається вручну або з cron раз на хвилину.
# Якщо в репозиторії з'явився новий коміт — тягне файли, збирає і перезапускає гру.
# Якщо нового нема — нічого не робить (швидко виходить).
#
# Перший запуск (на сервері):
#   git clone https://github.com/ТВІЙ_НІК/ТВІЙ_РЕПО.git ~/stalker-mmo
#   bash ~/stalker-mmo/scripts/server-pull.sh
# Автозапуск щохвилини:  crontab -e  і додай рядок
#   * * * * * bash $HOME/stalker-mmo/scripts/server-pull.sh >> $HOME/pull.log 2>&1
# Секрети (необов'язково): файл ~/zona.env з рядками SUPABASE_URL=... і SUPABASE_SERVICE_KEY=...
# ============================================================================
set -e
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"   # у cron PATH куций
DIR="$HOME/stalker-mmo"
BRANCH="${BRANCH:-main}"

# Не запускати двічі одночасно (якщо збірка ще йде, а cron вже стартував знову)
exec 9>/tmp/zona-pull.lock
flock -n 9 || exit 0

cd "$DIR"
git fetch -q origin "$BRANCH"
NEW=$(git rev-parse "origin/$BRANCH")
OLD=$(git rev-parse HEAD)
# Нічого нового, гра зібрана і запущена — виходимо
if [ "$NEW" = "$OLD" ] && [ -f public/game.js ] && pm2 describe zona >/dev/null 2>&1; then exit 0; fi

echo "[$(date '+%F %T')] Оновлення: ${OLD:0:7} -> ${NEW:0:7}"
git reset --hard "origin/$BRANCH"          # node_modules, game.js, секрети поза git — не чіпає
npm install --no-audit --no-fund
npm run build

if [ -f "$HOME/zona.env" ]; then set -a; . "$HOME/zona.env"; set +a; fi
export PORT="${PORT:-7860}"

if pm2 describe zona >/dev/null 2>&1; then
  pm2 restart zona --update-env
else
  pm2 start dist/server.js --name zona
  sudo env PATH="$PATH" pm2 startup systemd -u "$USER" --hp "$HOME" >/dev/null 2>&1 || true
fi
pm2 save >/dev/null
grep -o "render-v6 [0-9: -]*" public/game.js | head -1 | sed "s/^/Клієнт зібрано: /"
echo "[$(date '+%F %T')] Готово."
