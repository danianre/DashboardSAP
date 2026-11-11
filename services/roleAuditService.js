const fs = require('fs');
const path = require('path');
const { executeRfc } = require('../config/sap');

// Cache en memoria para no saturar SAP con peticiones simultáneas
let _liveAuditCache = null;
let _liveAuditLastFetch = 0;
const CACHE_TTL_MS = 30 * 1000; // 30 segundos de caché para navegación ágil

/**
 * Consulta las asignaciones vigentes de roles en SAP (tabla AGR_USERS)
 * y concilia con la línea base de la auditoría de transacciones no usadas.
 * 
 * @param {boolean} forceRefresh - Si es true, ignora el TTL e invoca SAP RFC
 * @returns {Promise<Object>} Datos conciliados con métricas actualizadas
 */
async function getReconciledUnusedRolesAudit(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _liveAuditCache && (now - _liveAuditLastFetch) < CACHE_TTL_MS) {
    return _liveAuditCache;
  }

  const baselinePath = path.join(__dirname, '..', 'data', 'unused_roles_audit.json');
  if (!fs.existsSync(baselinePath)) {
    throw new Error('Archivo base de auditoría de roles no disponible en el servidor.');
  }

  const baselineRaw = fs.readFileSync(baselinePath, 'utf8');
  const baseline = JSON.parse(baselineRaw);

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  let activeRolesMap = null;
  let isLiveSap = false;

  try {
    // Consultar tabla AGR_USERS en vivo desde SAP
    const resAgr = await executeRfc('RFC_READ_TABLE', {
      QUERY_TABLE: 'AGR_USERS',
      DELIMITER: '|',
      FIELDS: [
        { FIELDNAME: 'UNAME' },
        { FIELDNAME: 'AGR_NAME' },
        { FIELDNAME: 'TO_DAT' }
      ]
    });

    if (resAgr && Array.isArray(resAgr.DATA)) {
      activeRolesMap = new Set();
      resAgr.DATA.forEach(row => {
        const parts = row.WA.split('|').map(s => s.trim());
        const uname = parts[0];
        const role = parts[1];
        const toDat = parts[2];
        if (!toDat || toDat === '00000000' || toDat >= today) {
          activeRolesMap.add(`${uname}::${role}`);
        }
      });
      isLiveSap = true;
    }
  } catch (err) {
    console.warn('[ROLE AUDIT SERVICE] No se pudo consultar AGR_USERS en SAP, usando línea base:', err.message);
  }

  let totalBaseline180 = 0;
  let totalBaseline90 = 0;
  let totalRemoved180 = 0;
  let totalRemoved90 = 0;

  const reconciledUsers = [];

  baseline.users.forEach(u => {
    totalBaseline180 += (u.roles180 || []).length;
    totalBaseline90 += (u.roles90 || []).length;

    let activeRoles180 = u.roles180 || [];
    let activeRoles90 = u.roles90 || [];
    let removedRoles180 = [];
    let removedRoles90 = [];

    if (isLiveSap && activeRolesMap) {
      activeRoles180 = (u.roles180 || []).filter(r => {
        const isAssigned = activeRolesMap.has(`${u.username}::${r.role}`);
        if (!isAssigned) removedRoles180.push(r.role);
        return isAssigned;
      });

      activeRoles90 = (u.roles90 || []).filter(r => {
        const isAssigned = activeRolesMap.has(`${u.username}::${r.role}`);
        if (!isAssigned) removedRoles90.push(r.role);
        return isAssigned;
      });
    }

    totalRemoved180 += removedRoles180.length;
    totalRemoved90 += removedRoles90.length;

    // Solo incluimos en la lista activa de usuarios si aún tiene roles pendientes de eliminar
    if (activeRoles180.length > 0 || activeRoles90.length > 0) {
      reconciledUsers.push({
        ...u,
        roles180: activeRoles180,
        roles90: activeRoles90,
        zeroRoles180Count: activeRoles180.length,
        zeroRoles90Count: activeRoles90.length,
        alreadyRemoved180Count: removedRoles180.length,
        alreadyRemoved90Count: removedRoles90.length,
        alreadyRemoved180Roles: removedRoles180
      });
    }
  });

  // Re-ordenar por cantidad de roles pendientes en 180d descendente
  reconciledUsers.sort((a, b) => b.roles180.length - a.roles180.length || b.roles90.length - a.roles90.length);

  const totalRolesToRemove180 = isLiveSap ? (totalBaseline180 - totalRemoved180) : (baseline.metrics.totalRolesToRemove180 || 0);
  const totalRolesToRemove90 = isLiveSap ? (totalBaseline90 - totalRemoved90) : (baseline.metrics.totalRolesToRemove90 || 0);

  const result = {
    success: true,
    isLiveSap,
    lastUpdated: new Date().toISOString(),
    metrics: {
      totalActiveUsers: baseline.metrics.totalActiveUsers || 338,
      usersWithZeroRoles180: reconciledUsers.filter(u => u.roles180.length > 0).length,
      usersWithZeroRoles90: reconciledUsers.filter(u => u.roles90.length > 0).length,
      totalRolesToRemove180,
      totalRolesToRemove90,
      totalRolesAlreadyRemoved180: totalRemoved180,
      totalRolesAlreadyRemoved90: totalRemoved90,
      totalBaseline180,
      totalBaseline90,
      totalRolesSeasonalValidation: baseline.metrics.totalRolesSeasonalValidation || 36
    },
    users: reconciledUsers
  };

  _liveAuditCache = result;
  _liveAuditLastFetch = now;

  return result;
}

module.exports = {
  getReconciledUnusedRolesAudit
};
