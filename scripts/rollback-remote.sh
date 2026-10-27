#!/usr/bin/env bash
# ==============================================================================
# Script de Reversión (Rollback) a la última versión funcional en Linux
# Uso: ./scripts/rollback-remote.sh [ruta_archivo_backup.tar.gz]
# ==============================================================================
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-$(pwd)}"
BACKUP_ROOT="${BACKUP_ROOT:-${DEPLOY_DIR}/backups}"
APP_PORT="${APP_PORT:-3000}"
TARGET_BACKUP="${1:-}"

cd "${DEPLOY_DIR}"

if [ -z "${TARGET_BACKUP}" ]; then
  TARGET_BACKUP="$(ls -1t "${BACKUP_ROOT}"/release_*.tar.gz 2>/dev/null | head -n 1 || true)"
fi

if [ -z "${TARGET_BACKUP}" ] || [ ! -f "${TARGET_BACKUP}" ]; then
  echo "❌ No se encontró un archivo de respaldo válido en ${BACKUP_ROOT}."
  exit 1
fi

echo "========================================================"
echo " ⏪ Iniciando reversión desde respaldo: ${TARGET_BACKUP}"
echo "========================================================"

# Restaurar código preservando bases de datos actuales y .env si ya existen
tar --exclude='./database.sqlite' \
    --exclude='./monitor_sap.sqlite' \
    --exclude='./.env' \
    -xzf "${TARGET_BACKUP}" -C "${DEPLOY_DIR}"

# Reiniciar el servicio
if command -v pm2 >/dev/null 2>&1 && pm2 list | grep -q "online\|stopped"; then
  pm2 reload all --update-env || pm2 restart all
elif systemctl list-units --type=service | grep -qE "sap|notificaciones|dashboard"; then
  SVC_NAME="$(systemctl list-units --type=service --no-legend | awk '{print $1}' | grep -E "sap|notificaciones|dashboard" | head -n 1)"
  if [ -n "${SVC_NAME}" ]; then
    sudo systemctl restart "${SVC_NAME}"
  fi
fi

sleep 2
curl -fsSL --max-time 5 "http://127.0.0.1:${APP_PORT}/" >/dev/null && \
  echo "✅ Reversión completada y servicio respondiendo en puerto ${APP_PORT}."
