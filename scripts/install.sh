#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="playerokharness"

echo "==> Установка PlayerOK Harness (pkh) из ${APP_DIR}"

if ! command -v node >/dev/null 2>&1; then
  echo "Ошибка: требуется Node.js >= 20 (https://nodejs.org)"
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "==> Устанавливаю pnpm через corepack..."
  corepack enable || npm install -g pnpm
fi

cd "${APP_DIR}"
pnpm install
pnpm build

if command -v systemctl >/dev/null 2>&1 && [[ "$(id -u)" -eq 0 ]]; then
  cat >/etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=PlayerOK Harness (pkh) — Cordis 4 + TypeScript
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=$(command -v node) ${APP_DIR}/packages/app/dist/cli.js start --data-dir ${APP_DIR}
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

  cat >/usr/local/bin/pkh <<EOF
#!/usr/bin/env bash
case "\${1:-status}" in
  setup)    node "${APP_DIR}/packages/app/dist/cli.js" setup --data-dir "${APP_DIR}" ;;
  doctor)   node "${APP_DIR}/packages/app/dist/cli.js" doctor --data-dir "${APP_DIR}" ;;
  plugins)  node "${APP_DIR}/packages/app/dist/cli.js" plugins --data-dir "${APP_DIR}" ;;
  start)    systemctl start ${SERVICE_NAME} ;;
  stop)     systemctl stop ${SERVICE_NAME} ;;
  restart)  systemctl restart ${SERVICE_NAME} ;;
  status)   systemctl status ${SERVICE_NAME} ;;
  enable)   systemctl enable ${SERVICE_NAME} ;;
  disable)  systemctl disable ${SERVICE_NAME} ;;
  log)      journalctl -u ${SERVICE_NAME} -f ;;
  log100)   journalctl -u ${SERVICE_NAME} -n 100 --no-pager ;;
  *)        echo "Использование: pkh {setup|doctor|plugins|start|stop|restart|status|enable|disable|log|log100}" ;;
esac
EOF
  chmod +x /usr/local/bin/pkh
  systemctl daemon-reload
  echo "✅ Установлен systemd-сервис ${SERVICE_NAME} и команда pkh"
  echo "   Запустите первичную настройку: pkh setup"
else
  echo "✅ Сборка завершена. Запустите настройку:"
  echo "   node ${APP_DIR}/packages/app/dist/cli.js setup"
  echo "   node ${APP_DIR}/packages/app/dist/cli.js start"
fi
