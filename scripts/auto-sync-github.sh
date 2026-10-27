#!/usr/bin/env bash
# ==============================================================================
# Sincronizador Automático CD (GitHub -> Servidor Linux 10.0.0.146)
# Revisa si existen nuevos commits confirmados en la rama principal de GitHub
# y ejecuta scripts/deploy-remote.sh de forma controlada con registro en deploy.log.
# ==============================================================================
set -euo pipefail

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
DEPLOY_DIR="${DEPLOY_DIR:-/home/plant/app-notificaciones-sap}"
BRANCH="${BRANCH:-main}"
LOCK_FILE="/tmp/sap_platform_autosync.lock"
LOG_FILE="${DEPLOY_DIR}/deploy.log"

exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  exit 0
fi

cd "${DEPLOY_DIR}"
git fetch origin "${BRANCH}" --quiet

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "origin/${BRANCH}")"

if [ "${LOCAL_SHA}" != "${REMOTE_SHA}" ]; then
  {
    echo ""
    echo ">>> [$(date -Is)] Detectado nuevo commit en origin/${BRANCH}: ${LOCAL_SHA:0:7} -> ${REMOTE_SHA:0:7}"
    bash "${DEPLOY_DIR}/scripts/deploy-remote.sh"
  } >> "${LOG_FILE}" 2>&1
fi
