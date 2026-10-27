const { executeRfc } = require('../config/sap');

let cachedResetsData = null;
let lastFetchTimestamp = 0;
const CACHE_TTL_MS = 15000; // 15 segundos de caché en memoria

const MONTH_NAMES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

/**
 * Procesa y enriquece la lista de logs para auditoría, filtros mensuales y reporte de ahorro
 */
function processPasswordResetLogs(rawLogs) {
  const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const currentMonthNum = new Date().getMonth() + 1;
  const currentYear = new Date().getFullYear();
  const thisMonthKey = `${currentYear}-${String(currentMonthNum).padStart(2, '0')}`;

  const logs = rawLogs.map((item, idx) => {
    const rawDate = item.raw_date || '';
    const rawTime = item.raw_time || item.time || '';

    let year = currentYear;
    let monthNum = currentMonthNum;
    let day = '01';
    let dateFormatted = item.date || rawDate;

    if (rawDate.length === 8) {
      year = parseInt(rawDate.slice(0, 4), 10);
      monthNum = parseInt(rawDate.slice(4, 6), 10);
      day = rawDate.slice(6, 8);
      dateFormatted = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${day}`;
    }

    let timeFormatted = rawTime;
    if (rawTime.length === 6 && !rawTime.includes(':')) {
      timeFormatted = `${rawTime.slice(0, 2)}:${rawTime.slice(2, 4)}:${rawTime.slice(4, 6)}`;
    }

    const monthKey = `${year}-${String(monthNum).padStart(2, '0')}`;
    const monthName = `${MONTH_NAMES[monthNum - 1] || 'Mes ' + monthNum} ${year}`;
    const hourNum = parseInt((timeFormatted.slice(0, 2) || '0'), 10);

    return {
      id: item.id || idx + 1,
      mandt: item.mandt || '300',
      bname: item.bname || 'DESCONOCIDO',
      raw_date: rawDate,
      date: dateFormatted,
      time: timeFormatted,
      hour: hourNum,
      year,
      month_num: monthNum,
      month_key: monthKey,
      month_name: monthName,
      minutes_saved: 15,
      operation: item.operation || 'Autogestión de Clave CADI',
      status: item.status || 'EXITOSO'
    };
  });

  // Ordenar de más reciente a más antiguo
  logs.sort((a, b) => (b.raw_date + b.time).localeCompare(a.raw_date + a.time));

  // Agrupaciones mensuales
  const monthlyStatsMap = {};
  const userStatsMap = {};
  const hourlyCount = Array(24).fill(0);

  logs.forEach((log) => {
    // 1. Mensual
    if (!monthlyStatsMap[log.month_key]) {
      monthlyStatsMap[log.month_key] = {
        month_key: log.month_key,
        year: log.year,
        month_num: log.month_num,
        label: log.month_name,
        total_resets: 0,
        users_set: new Set(),
        hours_saved: 0,
        user_wait_hours_saved: 0
      };
    }
    const m = monthlyStatsMap[log.month_key];
    m.total_resets += 1;
    m.users_set.add(log.bname);

    // 2. Top Usuarios
    if (!userStatsMap[log.bname]) {
      userStatsMap[log.bname] = {
        bname: log.bname,
        total_resets: 0,
        first_date: log.date,
        last_date: log.date,
        months_active: new Set()
      };
    }
    userStatsMap[log.bname].total_resets += 1;
    userStatsMap[log.bname].months_active.add(log.month_key);
    if (log.date > userStatsMap[log.bname].last_date) {
      userStatsMap[log.bname].last_date = log.date;
    }

    // 3. Distribución horaria
    if (log.hour >= 0 && log.hour < 24) {
      hourlyCount[log.hour] += 1;
    }
  });

  const monthlyBreakdown = Object.values(monthlyStatsMap)
    .sort((a, b) => b.month_key.localeCompare(a.month_key))
    .map((m) => ({
      month_key: m.month_key,
      year: m.year,
      month_num: m.month_num,
      label: m.label,
      total_resets: m.total_resets,
      unique_users: m.users_set.size,
      hours_saved: parseFloat(((m.total_resets * 15) / 60).toFixed(2)),
      user_wait_hours_saved: parseFloat(((m.total_resets * 45) / 60).toFixed(2))
    }));

  const availableMonths = monthlyBreakdown.map((m) => ({
    key: m.month_key,
    label: m.label,
    count: m.total_resets,
    hours_saved: m.hours_saved
  }));

  const topUsers = Object.values(userStatsMap)
    .sort((a, b) => b.total_resets - a.total_resets)
    .map((u) => ({
      bname: u.bname,
      total_resets: u.total_resets,
      hours_saved: parseFloat(((u.total_resets * 15) / 60).toFixed(2)),
      last_date: u.last_date,
      months_count: u.months_active.size
    }));

  const totalCount = logs.length;
  const totalUniqueUsers = Object.keys(userStatsMap).length;
  const totalHoursSaved = parseFloat(((totalCount * 15) / 60).toFixed(2));
  const totalUserWaitHoursSaved = parseFloat(((totalCount * 45) / 60).toFixed(2));

  const resetsToday = logs.filter((l) => l.raw_date === todayStr).length;
  const resetsThisMonth = (monthlyStatsMap[thisMonthKey] ? monthlyStatsMap[thisMonthKey].total_resets : 0);

  // Distribución por franjas
  const morningResets = hourlyCount.slice(6, 12).reduce((a, b) => a + b, 0);
  const afternoonResets = hourlyCount.slice(12, 18).reduce((a, b) => a + b, 0);
  const nightResets = hourlyCount.slice(18, 24).reduce((a, b) => a + b, 0) + hourlyCount.slice(0, 6).reduce((a, b) => a + b, 0);

  return {
    total_count: totalCount,
    total_unique_users: totalUniqueUsers,
    total_hours_saved: totalHoursSaved,
    total_user_wait_hours_saved: totalUserWaitHoursSaved,
    resets_today: resetsToday,
    resets_month: resetsThisMonth,
    current_month_key: thisMonthKey,
    current_month: currentMonthNum,
    current_month_name: MONTH_NAMES[currentMonthNum - 1] || 'Mes actual',
    estimated_hours_saved: parseFloat(((resetsThisMonth * 15) / 60).toFixed(2)) || totalHoursSaved,
    available_months: availableMonths,
    monthly_breakdown: monthlyBreakdown,
    top_users: topUsers,
    hourly_distribution: {
      hourly_counts: hourlyCount,
      morning: morningResets,
      afternoon: afternoonResets,
      night: nightResets
    },
    logs
  };
}

/**
 * Consulta en tiempo real la tabla ZPW_RESET_LOG desde SAP mediante RFC_READ_TABLE
 */
async function fetchPasswordResetsFromSap(forceRefresh = false) {
  if (process.env.SAP_LIVE !== 'true') {
    return null;
  }

  const now = Date.now();
  if (!forceRefresh && cachedResetsData && (now - lastFetchTimestamp) < CACHE_TTL_MS) {
    return cachedResetsData;
  }

  try {
    const res = await executeRfc('RFC_READ_TABLE', {
      QUERY_TABLE: 'ZPW_RESET_LOG',
      DELIMITER: '|',
      ROWCOUNT: 2000
    });

    if (!res || !Array.isArray(res.DATA)) {
      return cachedResetsData || null;
    }

    const rawLogs = res.DATA.map((row, idx) => {
      const parts = (row.WA || '').split('|');
      const mandt = (parts[0] || '').trim();
      const bname = (parts[1] || '').trim();
      const rawDate = (parts[2] || '').trim();
      const rawTime = (parts[3] || '').trim();

      return {
        id: idx + 1,
        mandt,
        bname,
        raw_date: rawDate,
        raw_time: rawTime,
        operation: 'Autogestión de Clave CADI',
        status: 'EXITOSO'
      };
    });

    const processed = processPasswordResetLogs(rawLogs);
    processed.source = 'SAP_TABLE_ZPW_RESET_LOG';

    cachedResetsData = processed;
    lastFetchTimestamp = now;
    return processed;
  } catch (err) {
    console.error('[PASSWORD RESET SERVICE] Error leyendo ZPW_RESET_LOG vía RFC_READ_TABLE:', err.message);
    return cachedResetsData || null;
  }
}

/**
 * Fallback de datos de ZPW_RESET_LOG si SAP estuviera offline (con histórico multimes)
 */
function getPasswordResetsFallback() {
  const mockRawLogs = [
    // Octubre 2026
    { id: 11, mandt: '300', bname: 'spimienta', raw_date: '20261026', raw_time: '085446', operation: 'Autogestión de Clave CADI', status: 'EXITOSO' },
    { id: 10, mandt: '300', bname: 'lbarros', raw_date: '20261024', raw_time: '181322', operation: 'Autogestión de Clave CADI', status: 'EXITOSO' },
    { id: 5, mandt: '300', bname: 'ajaimes', raw_date: '20261024', raw_time: '091735', operation: 'Autogestión de Clave CADI', status: 'EXITOSO' },
    { id: 7, mandt: '300', bname: 'dosorio', raw_date: '20261024', raw_time: '084457', operation: 'Autogestión de Clave CADI', status: 'EXITOSO' },
    { id: 4, mandt: '300', bname: 'ajaimes', raw_date: '20261024', raw_time: '084150', operation: 'Autogestión de Clave CADI', status: 'EXITOSO' },
    { id: 3, mandt: '300', bname: 'ajaimes', raw_date: '20261024', raw_time: '081448', operation: 'Autogestión de Clave CADI', status: 'EXITOSO' },
    { id: 6, mandt: '300', bname: 'dosorio', raw_date: '20261023', raw_time: '105840', operation: 'Autogestión de Clave CADI', status: 'EXITOSO' },
    { id: 1, mandt: '300', bname: 'Aalvarado', raw_date: '20261020', raw_time: '144531', operation: 'Autogestión de Clave CADI', status: 'EXITOSO' },
    { id: 8, mandt: '300', bname: 'etorres', raw_date: '20261020', raw_time: '133028', operation: 'Autogestión de Clave CADI', status: 'EXITOSO' },
    { id: 2, mandt: '300', bname: 'SOSALAZAR', raw_date: '20261019', raw_time: '181822', operation: 'Autogestión de Clave CADI', status: 'EXITOSO' },
    { id: 9, mandt: '300', bname: 'lbarrera', raw_date: '20261019', raw_time: '084056', operation: 'Autogestión de Clave CADI', status: 'EXITOSO' },
    // Septiembre 2026 (histórico de prueba si offline)
    { id: 12, mandt: '300', bname: 'mrodriguez', raw_date: '20260928', raw_time: '091210', operation: 'Autogestión de Clave CADI', status: 'EXITOSO' },
    { id: 13, mandt: '300', bname: 'cgonzalez', raw_date: '20260925', raw_time: '142015', operation: 'Autogestión de Clave CADI', status: 'EXITOSO' },
    { id: 14, mandt: '300', bname: 'spimienta', raw_date: '20260918', raw_time: '110530', operation: 'Autogestión de Clave CADI', status: 'EXITOSO' },
    { id: 15, mandt: '300', bname: 'jherrera', raw_date: '20260910', raw_time: '083045', operation: 'Autogestión de Clave CADI', status: 'EXITOSO' },
    // Agosto 2026
    { id: 16, mandt: '300', bname: 'atorres', raw_date: '20260822', raw_time: '164012', operation: 'Autogestión de Clave CADI', status: 'EXITOSO' },
    { id: 17, mandt: '300', bname: 'ajaimes', raw_date: '20260815', raw_time: '095500', operation: 'Autogestión de Clave CADI', status: 'EXITOSO' }
  ];

  const processed = processPasswordResetLogs(mockRawLogs);
  processed.source = 'FALLBACK_LOCAL';
  return processed;
}

/**
 * Obtiene el log procesado, con soporte opcional de filtro por mes o usuario
 */
async function getPasswordResetsLog(forceRefresh = false, filters = {}) {
  let data = await fetchPasswordResetsFromSap(forceRefresh);
  if (!data) {
    data = getPasswordResetsFallback();
  }

  const { month, user } = filters;
  if (!month && !user) {
    return data;
  }

  let filteredLogs = [...data.logs];
  if (month && month !== 'ALL') {
    filteredLogs = filteredLogs.filter((l) => l.month_key === month);
  }
  if (user && user.trim() !== '') {
    const q = user.trim().toLowerCase();
    filteredLogs = filteredLogs.filter((l) => l.bname.toLowerCase().includes(q));
  }

  const filteredHours = parseFloat(((filteredLogs.length * 15) / 60).toFixed(2));
  const filteredUsers = new Set(filteredLogs.map((l) => l.bname)).size;

  return {
    ...data,
    filtered: {
      month: month || 'ALL',
      user: user || '',
      count: filteredLogs.length,
      unique_users: filteredUsers,
      hours_saved: filteredHours
    },
    logs: filteredLogs
  };
}

module.exports = {
  fetchPasswordResetsFromSap,
  getPasswordResetsFallback,
  getPasswordResetsLog,
  MONTH_NAMES
};
