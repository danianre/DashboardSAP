#!/usr/bin/env bash
# ==============================================================================
# Script de Despliegue Controlado y Reversible para Servidor Linux (10.0.0.146)
# Preserva .env y bases de datos SQLite locales, genera respaldo previo,
# valida código antes de publicar, registra el commit activo y ejecuta
# reversión automática si falla la validación o el healthcheck.
# ==============================================================================
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-$(pwd)}"
BACKUP_ROOT="${BACKUP_ROOT:-${DEPLOY_DIR}/backups}"
BRANCH="${BRANCH:-main}"
APP_PORT="${APP_PORT:-3000}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="${BACKUP_ROOT}/release_${TIMESTAMP}.tar.gz"

echo "========================================================"
echo " Iniciando despliegue controlado en: ${DEPLOY_DIR}"
echo " Fecha/Hora: $(date -Is)"
echo "========================================================"

mkdir -p "${BACKUP_ROOT}"
cd "${DEPLOY_DIR}"
git config core.fileMode false || true

# 1. Identificar commit actual antes de actualizar
PREV_COMMIT="none"
if git rev-parse HEAD >/dev/null 2>&1; then
  PREV_COMMIT="$(git rev-parse HEAD)"
fi
echo "[1/6] Commit previo detectado: ${PREV_COMMIT}"

# 2. Crear respaldo recuperable del código y bases de datos SQLite (sin exponer secretos fuera del servidor)
echo "[2/6] Generando copia de seguridad previa en ${BACKUP_FILE}..."
tar --exclude='./node_modules' \
    --exclude='./backups' \
    --exclude='./.git' \
    -czf "${BACKUP_FILE}" .
chmod 600 "${BACKUP_FILE}"
# Conservar los últimos 10 respaldos para no saturar disco
ls -1t "${BACKUP_ROOT}"/release_*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm -f
echo "      Respaldo creado exitosamente."

# 3. Sincronizar código desde GitHub de forma controlada
echo "[3/6] Obteniendo cambios desde origin/${BRANCH}..."
git fetch origin "${BRANCH}"
TARGET_COMMIT="$(git rev-parse "origin/${BRANCH}")"
git checkout -- package-lock.json 2>/dev/null || true
git merge --ff-only "origin/${BRANCH}"

# 4. Validar código e instalar dependencias si package.json cambió (ANTES de tocar el servicio en ejecución)
echo "[4/6] Validando integridad del paquete..."
if [ "${PREV_COMMIT}" != "none" ] && git diff --name-only "${PREV_COMMIT}" "${TARGET_COMMIT}" | grep -q "^package.json$"; then
  echo "      Cambio detectado en package.json. Actualizando dependencias..."
  npm install --omit=dev --ignore-scripts
  git checkout -- package-lock.json 2>/dev/null || true
fi

if ! node scripts/validate-build.js; then
  echo "⛔ [BLOQUEO DE SEGURIDAD]: La validación falló. Restaurando commit ${PREV_COMMIT} sin reiniciar el servicio..."
  if [ "${PREV_COMMIT}" != "none" ]; then
    git reset --hard "${PREV_COMMIT}"
  fi
  exit 1
fi

# 5. Registrar metadatos de la versión desplegada
cat > .deploy-meta.json <<EOF
{
  "commit": "${TARGET_COMMIT}",
  "previousCommit": "${PREV_COMMIT}",
  "branch": "${BRANCH}",
  "backupFile": "${BACKUP_FILE}",
  "deployedAt": "$(date -Is)"
}
EOF

# 6. Reiniciar únicamente el servicio de la aplicación Node.js
echo "[5/6] Recargando servicio de aplicación en PM2..."
if command -v pm2 >/dev/null 2>&1 && pm2 list | grep -q "sap-notificaciones"; then
  pm2 reload sap-notificaciones --update-env
elif command -v pm2 >/dev/null 2>&1 && pm2 list | grep -q "online\|stopped"; then
  pm2 reload all --update-env
fi

# 7. Comprobaciones automáticas posteriores al despliegue (Healthcheck + Rutas)
echo "[6/6] Verificando estado del sitio en http://127.0.0.1:${APP_PORT}..."
sleep 2

check_url() {
  local url="$1"
  local expected="$2"
  local body
  body="$(curl -fsSL --max-time 8 "${url}" || true)"
  if [[ "${body}" != *"${expected}"* ]]; then
    echo "❌ Falló la verificación en ${url} (no se encontró '${expected}')."
    return 1
  fi
  echo "✅ Ruta verificada: ${url}"
  return 0
}

if ! check_url "http://127.0.0.1:${APP_PORT}/api/health" "\"status\":\"ok\"" || \
   ! check_url "http://127.0.0.1:${APP_PORT}/" "Plataforma de Aplicaciones SAP" || \
   ! check_url "http://127.0.0.1:${APP_PORT}/monitor-sap" "Centro de Monitoreo" || \
   ! check_url "http://127.0.0.1:${APP_PORT}/notificaciones-sap" "Notificación SAP Producción"; then
  echo "⚠️ ERROR EN VERIFICACIÓN POST-DESPLIEGUE. Ejecutando reversión automática..."
  bash "${DEPLOY_DIR}/scripts/rollback-remote.sh" "${BACKUP_FILE}"
  exit 1
fi

echo "========================================================"
echo " 🎉 Despliegue completado y verificado exitosamente"
echo " 🔖 Commit desplegado: ${TARGET_COMMIT}"
echo " 📦 Respaldo previo:   ${BACKUP_FILE}"
echo "========================================================"
