const { executeRfc } = require('../config/sap');
const { db } = require('./snapshotService');

/**
 * Limpia el texto de mensaje SAP de la tabla ZHR_LOG_BLOQUEO para no mostrar la cédula
 * (evita redundancia y protege datos, dado que la cédula ya se muestra en su propia columna).
 */
function cleanRetiredSapMessage(msg, idCard) {
  let clean = String(msg || '');
  clean = clean.replace(/El usuario con\s+(?:cédula|cedula|cc|id)?\s*[:\s]*[\d\w.-]*\s*no tiene usuario en SAP\.?/gi, 'El colaborador no tiene usuario en SAP.');
  clean = clean.replace(/\s*\((?:cédula|cedula|cc|id)\s*[:\s][^)]*\)/gi, '');
  clean = clean.replace(/\s*(?:cédula|cedula|cc)\s*:\s*\d+/gi, '');
  if (idCard && String(idCard).trim()) {
    const safeCard = String(idCard).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    clean = clean.replace(new RegExp('\\s*\\(?' + safeCard + '\\)?', 'gi'), '');
  }
  return clean.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Consulta en tiempo real la tabla ZHR_LOG_BLOQUEO desde SAP mediante RFC_READ_TABLE
 */
async function fetchFromSapTable() {
  if (process.env.SAP_LIVE !== 'true') {
    return null;
  }

  try {
    const res = await executeRfc('RFC_READ_TABLE', {
      QUERY_TABLE: 'ZHR_LOG_BLOQUEO',
      DELIMITER: '|',
      ROWCOUNT: 1000
    });

    if (!res || !Array.isArray(res.DATA)) {
      return null;
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const thisMonthPrefix = todayStr.slice(0, 7); // '2026-10'

    const users = res.DATA.map((row, idx) => {
      const parts = (row.WA || '').split('|');
      const bname = (parts[1] || '').trim();
      const rawDate = (parts[2] || '').trim();
      const rawTime = (parts[3] || '').trim();
      const cedula = (parts[4] || '').trim();
      const nombre = (parts[5] || '').trim();
      const rawMsgSap = (parts[6] || '').trim();
      const msgSap = cleanRetiredSapMessage(rawMsgSap, cedula);

      // Formateo YYYY-MM-DD
      let lockDate = rawDate;
      if (rawDate.length === 8) {
        lockDate = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
      }

      // Formateo HH:MM:SS
      let lockTime = rawTime;
      if (rawTime.length === 6) {
        lockTime = `${rawTime.slice(0, 2)}:${rawTime.slice(2, 4)}:${rawTime.slice(4, 6)}`;
      }

      const hasSapUser = Boolean(bname && bname !== '-');
      const isSuccess = msgSap.toLowerCase().includes('bloqueado exitosamente');

      return {
        id: idx + 1,
        bname: bname || '-',
        has_sap_user: hasSapUser,
        pernr: cedula,
        id_card: cedula,
        full_name: nombre || 'Colaborador Retirado',
        department: hasSapUser ? 'Usuario SAP Activo' : 'Personal Operativo / Nómina',
        position: hasSapUser ? 'Cuenta de Diálogo SAP' : 'Sin Licencia SAP',
        retirement_date: lockDate,
        lock_date: lockDate,
        lock_time: lockTime,
        job_name: 'ZHR_BLOQUEO_RETIROS_DIARIO',
        hr_action: hasSapUser ? '03 - Baja con Usuario SAP' : '03 - Baja en Nómina HCM',
        status: hasSapUser && isSuccess ? 'BLOQUEADO' : (hasSapUser ? 'PROCESADO' : 'SIN USUARIO SAP'),
        action_taken: msgSap,
        msg_sap: msgSap
      };
    });

const SPANISH_MONTHS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

function buildAvailableMonths(users) {
  const map = new Map();
  users.forEach(u => {
    if (!u.lock_date) return;
    const ym = u.lock_date.slice(0, 7);
    if (!map.has(ym)) {
      const [y, m] = ym.split('-');
      const mIdx = parseInt(m, 10) - 1;
      const mName = SPANISH_MONTHS[mIdx] || m;
      map.set(ym, {
        value: ym,
        label: `${mName} ${y}`,
        year: parseInt(y, 10),
        month: parseInt(m, 10),
        blocked_count: 0,
        total_count: 0
      });
    }
    const entry = map.get(ym);
    entry.total_count++;
    if (u.has_sap_user) {
      entry.blocked_count++;
    }
  });

  return Array.from(map.values()).sort((a, b) => b.value.localeCompare(a.value));
}

    // Ordenar de más reciente a más antiguo
    users.sort((a, b) => (b.lock_date + ' ' + b.lock_time).localeCompare(a.lock_date + ' ' + a.lock_time));

    const totalRecords = users.length;
    const sapUsersBlocked = users.filter(u => u.has_sap_user).length;
    const withoutSapUser = users.filter(u => !u.has_sap_user).length;
    const blockedToday = users.filter(u => u.lock_date === todayStr && u.has_sap_user).length;
    const blockedThisMonth = users.filter(u => u.lock_date && u.lock_date.startsWith(thisMonthPrefix) && u.has_sap_user).length;
    const availableMonths = buildAvailableMonths(users);

    return {
      source: 'SAP_TABLE_ZHR_LOG_BLOQUEO',
      total_blocked: sapUsersBlocked,
      total_records: totalRecords,
      sap_users_blocked: sapUsersBlocked,
      without_sap_user: withoutSapUser,
      blocked_today: blockedToday,
      blocked_this_month: blockedThisMonth,
      query_date: todayStr,
      available_months: availableMonths,
      users
    };
  } catch (err) {
    console.error('[HR JOB SERVICE] Error leyendo ZHR_LOG_BLOQUEO vía RFC_READ_TABLE:', err.message);
    return null;
  }
}

/**
 * Consulta de respaldo en SQLite local (si SAP RFC estuviera desconectado)
 */
function fetchFromSqliteFallback() {
  return new Promise((resolve) => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const thisMonthPrefix = todayStr.slice(0, 7);

    db.all(`
      SELECT * FROM hr_retired_blocks_log
      ORDER BY lock_date DESC, lock_time DESC
    `, (err, rows) => {
      if (err || !rows || rows.length === 0) {
        return resolve({
          source: 'FALLBACK_EMPTY',
          total_blocked: 0,
          total_records: 0,
          sap_users_blocked: 0,
          without_sap_user: 0,
          blocked_today: 0,
          blocked_this_month: 0,
          query_date: todayStr,
          available_months: [],
          users: []
        });
      }

      const users = rows.map(r => {
        const cleanMsg = cleanRetiredSapMessage(r.action_taken, r.id_card || r.pernr);
        return {
          ...r,
          has_sap_user: Boolean(r.bname && r.bname !== '-'),
          action_taken: cleanMsg,
          msg_sap: cleanMsg
        };
      });

      const sapUsers = users.filter(u => u.has_sap_user);
      const availableMonths = buildAvailableMonths(users);

      resolve({
        source: 'SQLITE_LOCAL',
        total_blocked: sapUsers.length,
        total_records: users.length,
        sap_users_blocked: sapUsers.length,
        without_sap_user: users.length - sapUsers.length,
        blocked_today: sapUsers.filter(u => u.lock_date === todayStr).length,
        blocked_this_month: sapUsers.filter(u => u.lock_date && u.lock_date.startsWith(thisMonthPrefix)).length,
        query_date: todayStr,
        available_months: availableMonths,
        users
      });
    });
  });
}

/**
 * Obtiene el historial completo de bloqueos por retiro de personal (ZHR_LOG_BLOQUEO)
 */
async function getRetiredBlockedUsersHistory() {
  // 1. Intentar consulta en vivo a la tabla ZHR_LOG_BLOQUEO en SAP
  const liveData = await fetchFromSapTable();
  if (liveData) {
    return liveData;
  }

  // 2. Si RFC falla o no está configurado, usar SQLite local
  return await fetchFromSqliteFallback();
}

module.exports = {
  getRetiredBlockedUsersHistory,
  cleanRetiredSapMessage
};
