#!/usr/bin/env bash
# ============================================================================
# Автооновлення гри на сервері з GitHub. Один раз ставиш — далі сервер сам
# раз на хвилину дивиться, чи є нові файли в репозиторії, і якщо є —
# оновлює, збирає і перезапускає гру. Заходити по SSH більше не треба.
#
# Репозиторій може бути двох видів (скрипт розпізнає сам):
#   а) у ньому лежать файли проєкту (є package.json у корені);
#   б) у ньому лежать лише zip-архіви: береться НАЙНОВІШИЙ за часом коміту
#      і розпаковується в ~/stalker-mmo. Для телефона це найпростіше:
#      заливаєш zip на GitHub (Add file -> Upload files) — і сервер сам оновиться.
#
# Перший раз (в SSH-вікні сервера):
#   git clone https://github.com/ТВІЙ_НІК/РЕПОЗИТОРІЙ ~/zona
#   bash ~/zona/scripts/server-sync.sh --install   (для виду а)
#   для виду б: розпакуй один раз архів і запусти скрипт з нього, див. README
#
# Режими:  --install  поставити все й запустити стеження
#          --watch    нескінченний цикл стеження (його запускає pm2)
#          --once     одна перевірка/оновлення (за замовчуванням)
# Секрети (необов'язково): файл ~/zona.env з рядками SUPABASE_URL=... і SUPABASE_SERVICE_KEY=...
# ============================================================================
set -e
DIR="${ZONA_DIR:-$HOME/zona}"      # куди склоновано репозиторій
SELF="$(readlink -f "${BASH_SOURCE[0]}")"   # цей файл (де б він не лежав)
APP="zona"                         # назва процесу гри в pm2
WATCHER="zona-watch"               # назва процесу-наглядача в pm2
REV_FILE="$DIR/.deployed-rev"      # яка версія зараз запущена
LOG="$HOME/zona-sync.log"

# Увесь код у функціях і виклик в останньому рядку: так bash прочитає файл
# повністю, і оновлення самого скрипта посеред роботи нічого не ламає.

ensure_tools() {
  command -v git >/dev/null || sudo apt-get install -y git
  command -v npm >/dev/null || { sudo apt-get update -y && sudo apt-get install -y npm; }
  command -v pm2 >/dev/null || sudo npm install -g pm2
}

load_env() {
  if [ -f "$HOME/zona.env" ]; then set -a; . "$HOME/zona.env"; set +a; fi
  export PORT="${PORT:-7860}"
}

# Де лежить сам проєкт: у репозиторії (вид а) або в розпакованій папці (вид б)
app_dir() {
  if [ -f "$DIR/package.json" ]; then echo "$DIR"; else echo "$HOME/stalker-mmo"; fi
}

# Найновіший zip у репозиторії (за часом останнього коміту, а не за назвою)
newest_zip() {
  local best="" best_t=0 f t
  for f in "$DIR"/*.zip; do
    [ -e "$f" ] || continue
    t=$(git -C "$DIR" log -1 --format=%ct -- "$(basename "$f")" 2>/dev/null || echo 0)
    if [ "${t:-0}" -ge "$best_t" ]; then best="$f"; best_t="${t:-0}"; fi
  done
  echo "$best"
}

# Вид б: розпаковує найновіший архів у ~ (папка stalker-mmo всередині архіву)
unpack_zip_if_needed() {
  [ -f "$DIR/package.json" ] && return 0
  local zip; zip=$(newest_zip)
  [ -n "$zip" ] || { echo "У репозиторії немає ні package.json, ні zip-архіву."; exit 1; }
  command -v unzip >/dev/null || sudo apt-get install -y unzip
  echo "Архів: $(basename "$zip")"
  unzip -oq "$zip" -d "$HOME"
}

deploy() {
  local app; app=$(app_dir)
  cd "$app"
  npm install --no-audit --no-fund
  npm run build
  load_env
  if pm2 describe "$APP" >/dev/null 2>&1; then
    pm2 restart "$APP" --update-env
  else
    pm2 start dist/server.js --name "$APP" --cwd "$app"
  fi
  pm2 save >/dev/null
}

sync_once() {
  [ -d "$DIR/.git" ] || { echo "Немає репозиторію в $DIR. Спочатку: git clone <адреса> $DIR"; exit 1; }
  cd "$DIR"
  git fetch -q origin
  local branch remote deployed=""
  branch=$(git rev-parse --abbrev-ref HEAD)
  remote=$(git rev-parse "origin/$branch")
  [ -f "$REV_FILE" ] && deployed=$(cat "$REV_FILE")
  if [ "$remote" != "$deployed" ] || [ ! -f "$(app_dir)/dist/server.js" ]; then
    echo "[$(date '+%F %T')] Оновлення до ${remote:0:7}"
    git reset -q --hard "origin/$branch"
    unpack_zip_if_needed
    deploy
    echo "$remote" > "$REV_FILE"   # записуємо ТІЛЬКИ після успішної збірки
    echo "[$(date '+%F %T')] Готово"
  fi
}

install_all() {
  ensure_tools
  sync_once
  pm2 delete "$WATCHER" >/dev/null 2>&1 || true
  pm2 start "$SELF" --name "$WATCHER" --interpreter bash -- --watch
  pm2 save >/dev/null
  sudo env PATH="$PATH" pm2 startup systemd -u "$USER" --hp "$HOME" >/dev/null 2>&1 || true
  local ip
  ip=$(curl -s -H "Metadata-Flavor: Google" \
    http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip || true)
  echo "Все працює. Гра: http://${ip:-IP_СЕРВЕРА}:${PORT:-7860}"
  echo "Далі сервер сам оновлюватиметься з GitHub. Журнал: $LOG"
}

watch_loop() {
  while true; do
    bash "$SELF" --once >> "$LOG" 2>&1 || true   # щоразу запускається найновіша версія скрипта
    sleep 60
  done
}

main() {
  case "${1:---once}" in
    --install) install_all ;;
    --watch)   watch_loop ;;
    *)         ensure_tools; sync_once ;;
  esac
}
main "$@"; exit $?
