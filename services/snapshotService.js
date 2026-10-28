const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, '../monitor_sap.sqlite');
const db = new sqlite3.Database(dbPath);

let lastSavedBucket = null;
let collectorTimer = null;
let isCollecting = false;
let lastCollectedAt = null;
let lastCollectorError = null;
let lastCollectedMetrics = null;

// Asegurar que la tabla exista
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS system_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    active_sessions INTEGER,
    dia_busy_pct REAL,
    btc_busy_pct REAL,
    sm12_locks INTEGER,
    ws_errors INTEGER
  )`);

  // Crear índice en timestamp para consultas ultra-rápidas en tiempo real
  db.run(`CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON system_snapshots(timestamp)`);
});

/**
 * Guarda o actualiza la instantánea del sistema cada 15 segundos
 */
function saveSnapshot({ active_sessions, dia_busy_pct, btc_busy_pct = 0, sm12_locks = 0, ws_errors = 0 }) {
  const currentBucket = Math.floor(Date.now() / 15000); // Bucket exacto de 15 segundos

  return new Promise((resolve) => {
    if (lastSavedBucket === currentBucket) {
      // Actualizar el registro del bloque actual de 15 segundos para mantener el valor en vivo
      db.run(
        `UPDATE system_snapshots
         SET active_sessions = ?, dia_busy_pct = ?, btc_busy_pct = ?, sm12_locks = ?, ws_errors = ?
         WHERE id = (SELECT MAX(id) FROM system_snapshots)`,
        [active_sessions, dia_busy_pct, btc_busy_pct, sm12_locks, ws_errors],
        (err) => {
          if (err) console.error('[SNAPSHOT UPDATE ERROR]:', err.message);
          resolve(!err);
        }
      );
      return;
    }

    lastSavedBucket = currentBucket;
    const stmt = db.prepare(`
      INSERT INTO system_snapshots (timestamp, active_sessions, dia_busy_pct, btc_busy_pct, sm12_locks, ws_errors)
      VALUES (datetime('now'), ?, ?, ?, ?, ?)
    `);
    stmt.run([active_sessions, dia_busy_pct, btc_busy_pct, sm12_locks, ws_errors], function (err) {
      if (err) {
        console.error('[SNAPSHOT DB ERROR]:', err.message);
        resolve(false);
      } else {
        // Limpieza periódica de muestras mayores a 48 horas (5% de probabilidad para no bloquear I/O)
        if (Math.random() < 0.05) {
          db.run(`DELETE FROM system_snapshots WHERE timestamp < datetime('now', '-48 hours')`);
        }
        resolve(true);
      }
    });
    stmt.finalize();
  });
}

/**
 * Obtiene los registros REALES de las últimas 8 horas en intervalos de 15 segundos (~1.920 puntos)
 * ordenados cronológicamente desde la base de datos SQLite.
 * NUNCA genera datos falsos o simulados; retorna exclusivamente las muestras reales grabadas por el demonio 24/7.
 */
function getSnapshotsLast8Hours() {
  return new Promise((resolve) => {
    const query = `
      SELECT
        id,
        timestamp,
        datetime(timestamp, '-5 hours') as local_ts,
        active_sessions,
        dia_busy_pct,
        btc_busy_pct
      FROM system_snapshots
      WHERE timestamp >= datetime('now', '-8 hours')
      ORDER BY id ASC
      LIMIT 2500
    `;

    db.all(query, (err, rows) => {
      if (err) {
        console.error('[SNAPSHOT QUERY ERROR]:', err.message);
        return resolve([]);
      }

      if (!rows || rows.length === 0) {
        return resolve([]);
      }

      resolve(formatSnapshots(rows));
    });
  });
}

function formatSnapshots(rows) {
  return rows.map((r) => {
    let timeStr = '';
    // r.timestamp se persiste en UTC (ej. "2026-10-28 21:25:00")
    // Se convierte de forma garantizada a hora local Colombia (America/Bogota, UTC-5)
    if (r.timestamp) {
      const utcDate = new Date(String(r.timestamp).replace(' ', 'T') + 'Z');
      if (!isNaN(utcDate.getTime())) {
        timeStr = utcDate.toLocaleTimeString('es-CO', {
          timeZone: 'America/Bogota',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false
        });
      }
    }
    if (!timeStr) {
      const rawTs = r.local_ts || r.timestamp || '';
      if (rawTs) {
        const parts = rawTs.split(' ');
        if (parts[1]) {
          timeStr = parts[1].slice(0, 8); // Formato exacto HH:MM:SS
        }
      }
    }
    return {
      timestamp: r.local_ts || r.timestamp || '',
      time: timeStr,
      dia_busy_pct: Number(r.dia_busy_pct) || 0,
      btc_busy_pct: Number(r.btc_busy_pct) || 0,
      active_sessions: Number(r.active_sessions) || 0
    };
  });
}

/**
 * Ciclo de recolección continua en segundo plano (24 Horas):
 * Consulta SAP en tiempo real y persiste la instantánea exacta cada 15 segundos,
 * garantizando que al ingresar a cualquier hora del día exista el historial real continuo.
 */
async function runCollectorCycle() {
  if (isCollecting) return;
  isCollecting = true;

  try {
    const { fetchSapDashboardData } = require('./sapService');
    const sapData = await fetchSapDashboardData();

    let diaBusy = 0;
    let diaTotal = 0;
    let btcBusy = 0;
    let btcTotal = 0;

    if (Array.isArray(sapData.work_processes)) {
      sapData.work_processes.forEach(wp => {
        const status = (wp.wp_status || '').toLowerCase().trim();
        const isActive = (status === 'espera' || status === 'waiting')
          ? Boolean(wp.wp_bname && wp.wp_bname !== '-' && wp.wp_bname.trim() !== '')
          : true;

        if (wp.wp_typ === 'DIA') {
          diaTotal++;
          if (isActive) diaBusy++;
        } else if (wp.wp_typ === 'BTC') {
          btcTotal++;
          if (isActive) btcBusy++;
        }
      });
    }

    const diaBusyPct = diaTotal > 0 ? parseFloat(((diaBusy / diaTotal) * 100).toFixed(1)) : 0;
    const btcBusyPct = btcTotal > 0 ? parseFloat(((btcBusy / btcTotal) * 100).toFixed(1)) : 0;
    const activeSessions = Array.isArray(sapData.user_sessions) ? sapData.user_sessions.length : (sapData.active_users || 0);
    const sm12Locks = (sapData.sm12_locks || []).length;
    const wsErrors = sapData.ws_errors_count || 0;

    await saveSnapshot({
      active_sessions: activeSessions,
      dia_busy_pct: diaBusyPct,
      btc_busy_pct: btcBusyPct,
      sm12_locks: sm12Locks,
      ws_errors: wsErrors
    });

    lastCollectedAt = new Date().toISOString();
    lastCollectorError = null;
    lastCollectedMetrics = {
      diaBusyPct,
      btcBusyPct,
      activeSessions,
      sm12Locks,
      wsErrors,
      sapMode: sapData.mode,
      updatedAt: lastCollectedAt
    };
  } catch (err) {
    lastCollectorError = err.message || String(err);
    console.error('[SNAPSHOT 24/7 DAEMON ERROR]:', lastCollectorError);
  } finally {
    isCollecting = false;
  }
}

/**
 * Inicia el servicio demonio de recolección continua 24/7 en segundo plano.
 * No depende de conexiones del navegador de usuarios.
 */
function startSnapshotDaemon(intervalMs = 15000) {
  if (collectorTimer) {
    return;
  }

  console.log(`[SNAPSHOT 24/7 DAEMON] ⏱️ Iniciando grabación continua de rendimiento DIA/BTC (intervalo: ${intervalMs / 1000}s)`);

  // Ciclo inicial inmediato
  runCollectorCycle().catch(err => {
    console.error('[SNAPSHOT DAEMON START ERROR]:', err.message);
  });

  // Programación cíclica permanente
  collectorTimer = setInterval(runCollectorCycle, intervalMs);

  if (collectorTimer.unref) {
    collectorTimer.unref();
  }
}

function stopSnapshotDaemon() {
  if (collectorTimer) {
    clearInterval(collectorTimer);
    collectorTimer = null;
    console.log('[SNAPSHOT 24/7 DAEMON] Demonio detenido.');
  }
}

function getSnapshotDaemonStatus() {
  return {
    running: Boolean(collectorTimer),
    intervalMs: 15000,
    lastCollectedAt,
    lastError: lastCollectorError,
    latestMetrics: lastCollectedMetrics
  };
}

module.exports = {
  db,
  saveSnapshot,
  getSnapshotsLast8Hours,
  getSnapshotsLast2Hours: getSnapshotsLast8Hours,
  startSnapshotDaemon,
  stopSnapshotDaemon,
  getSnapshotDaemonStatus,
  runCollectorCycle,
  formatSnapshots
};
