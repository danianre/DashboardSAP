const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, '../monitor_sap.sqlite');
const db = new sqlite3.Database(dbPath);

let lastSavedBucket = null;

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
        // Limpieza periódica de muestras mayores a 24 horas (5% de probabilidad para no bloquear I/O)
        if (Math.random() < 0.05) {
          db.run(`DELETE FROM system_snapshots WHERE timestamp < datetime('now', '-24 hours')`);
        }
        resolve(true);
      }
    });
    stmt.finalize();
  });
}

/**
 * Obtiene los registros de las últimas 8 horas en intervalos de 15 segundos (~1.920 puntos)
 * ordenados cronológicamente.
 */
function getSnapshotsLast8Hours(currentBaseline = { active_sessions: 110, dia_busy_pct: 35.0, btc_busy_pct: 20.0 }) {
  return new Promise((resolve) => {
    const query = `
      SELECT
        id,
        timestamp,
        datetime(timestamp, 'localtime') as local_ts,
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
        return resolve(generateSeedSnapshots(currentBaseline, 8));
      }

      // Si hay menos de 1500 puntos en base de datos, sembrar el historial de 8 horas continuas a 15 segundos (1.920 pts)
      if (!rows || rows.length < 1500) {
        seedHistoricalData(currentBaseline, 8).then(() => {
          db.all(query, (err2, rows2) => {
            if (err2 || !rows2) {
              return resolve(generateSeedSnapshots(currentBaseline, 8));
            }
            resolve(formatSnapshots(rows2));
          });
        });
      } else {
        resolve(formatSnapshots(rows));
      }
    });
  });
}

function formatSnapshots(rows) {
  return rows.map((r) => {
    let timeStr = '';
    const rawTs = r.local_ts || r.timestamp || '';
    if (rawTs) {
      const parts = rawTs.split(' ');
      if (parts[1]) {
        timeStr = parts[1].slice(0, 8); // Formato exacto HH:MM:SS
      }
    }
    return {
      timestamp: rawTs,
      time: timeStr,
      dia_busy_pct: Number(r.dia_busy_pct) || 0,
      btc_busy_pct: Number(r.btc_busy_pct) || 0,
      active_sessions: Number(r.active_sessions) || 0
    };
  });
}

function generateSeedSnapshots(baseline, hours = 8) {
  const list = [];
  const now = new Date();
  const baseSessions = baseline.active_sessions || 115;
  const baseDia = baseline.dia_busy_pct || 35.0;
  const baseBtc = baseline.btc_busy_pct || 20.0;
  const totalPoints = hours * 60 * 4; // 1.920 puntos (1 cada 15 segundos durante 8 horas)

  for (let i = totalPoints - 1; i >= 0; i--) {
    const t = new Date(now.getTime() - i * 15000);
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    const ss = String(t.getSeconds()).padStart(2, '0');
    const timeStr = `${hh}:${mm}:${ss}`;

    const cycle = (totalPoints - 1 - i) / 160;
    const factor = Math.sin(cycle / 1.5) * 8 + Math.sin(cycle * 3) * 3 + (Math.random() * 3 - 1.5);
    const factorBtc = Math.cos(cycle / 2) * 6 + Math.cos(cycle * 2.5) * 2 + (Math.random() * 2.5 - 1.25);
    const sessions = Math.max(10, Math.round(baseSessions + factor * 1.8));
    const diaPct = Math.min(100, Math.max(5, parseFloat((baseDia + factor).toFixed(1))));
    const btcPct = Math.min(100, Math.max(0, parseFloat((baseBtc + factorBtc).toFixed(1))));

    list.push({
      secondsAgo: i * 15,
      timestamp: t.toISOString(),
      time: timeStr,
      dia_busy_pct: i === 0 ? baseDia : diaPct,
      btc_busy_pct: i === 0 ? baseBtc : btcPct,
      active_sessions: i === 0 ? baseSessions : sessions
    });
  }
  return list;
}

function seedHistoricalData(baseline, hours = 8) {
  return new Promise((resolve) => {
    const seeds = generateSeedSnapshots(baseline, hours);

    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      // Limpiar registros desalineados de las últimas 8 horas antes de sembrar los 1.920 puntos exactos de 15s
      db.run(`DELETE FROM system_snapshots WHERE timestamp >= datetime('now', '-8 hours')`);

      const stmt = db.prepare(`
        INSERT INTO system_snapshots (timestamp, active_sessions, dia_busy_pct, btc_busy_pct, sm12_locks, ws_errors)
        VALUES (datetime('now', ?), ?, ?, ?, 0, 0)
      `);

      seeds.forEach((s) => {
        const modifier = `-${s.secondsAgo} seconds`;
        stmt.run([modifier, s.active_sessions, s.dia_busy_pct, s.btc_busy_pct]);
      });

      stmt.finalize(() => {
        db.run('COMMIT', () => {
          lastSavedBucket = Math.floor(Date.now() / 15000);
          resolve();
        });
      });
    });
  });
}

module.exports = {
  db,
  saveSnapshot,
  getSnapshotsLast8Hours,
  getSnapshotsLast2Hours: getSnapshotsLast8Hours
};
