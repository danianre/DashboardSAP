const { executeRfc } = require('../config/sap');
const { db } = require('./snapshotService');

let cachedSt02Data = null;
let lastFetchTimestamp = 0;
let lastSampleBucket = null;
const CACHE_TTL_MS = 20000; // 20 s de caché para no saturar SAP con el auto-refresco de 5 s
const SAMPLE_BUCKET_MS = 5 * 60 * 1000; // una muestra histórica cada 5 minutos
const SAMPLE_RETENTION_DAYS = 8;

// Tabla de muestras ST02 para calcular tendencias (deltas de swaps y memoria)
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS st02_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    startup TEXT,
    payload TEXT NOT NULL
  )`);
});

// Catálogo alineado con las filas de la transacción ST02 (SAP GUI)
const BUFFER_CATALOG = {
  TTAB:  { group: 'Nametab (NTAB)', label: 'Table definition', parameter: 'rsdb/ntab/entrycount', dbBacked: true, order: 1 },
  FTAB:  { group: 'Nametab (NTAB)', label: 'Field definition', parameter: 'rsdb/ntab/ftabsize', dbBacked: true, order: 2 },
  SNTAB: { group: 'Nametab (NTAB)', label: 'Short NTAB', parameter: 'rsdb/ntab/sntabsize', dbBacked: true, order: 3 },
  IRBD:  { group: 'Nametab (NTAB)', label: 'Initial records', parameter: 'rsdb/ntab/irbdsize', dbBacked: true, order: 4 },
  PXA:   { group: 'Program', label: 'Program', parameter: 'abap/buffersize', dbBacked: true, order: 5 },
  CUA:   { group: 'Repository', label: 'CUA', parameter: 'rsdb/cua/buffersize', dbBacked: true, order: 6 },
  PRES:  { group: 'Repository', label: 'Screen', parameter: 'zcsa/presentation_buffer_area', dbBacked: true, order: 7 },
  CALE:  { group: 'Repository', label: 'Calendar', parameter: 'zcsa/calendar_area', dbBacked: true, order: 8 },
  OTR:   { group: 'Repository', label: 'OTR', parameter: 'rsdb/otr/buffersize_kb', dbBacked: false, order: 9 },
  TABL:  { group: 'Tables', label: 'Tables Buffer', parameter: 'zcsa/table_buffer_area', dbBacked: true, order: 10 },
  EIBUF: { group: 'Shared Memory', label: 'Export/import', parameter: 'rsdb/obj/buffersize', dbBacked: false, order: 11 },
  ESM:   { group: 'Shared Memory', label: 'Exp./ Imp. SHM', parameter: 'rsdb/esm/buffersize_kb', dbBacked: false, order: 12 }
};

function formatSapDateTime(dateStr, timeStr) {
  const d = String(dateStr || '').trim();
  const t = String(timeStr || '').trim();
  if (d.length !== 8) return '--';
  const formattedDate = `${d.slice(6, 8)}.${d.slice(4, 6)}.${d.slice(0, 4)}`;
  if (t.length !== 6) return formattedDate;
  return `${formattedDate} ${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
}

function sapToDate(dateStr, timeStr) {
  const d = String(dateStr || '').trim();
  const t = String(timeStr || '000000').trim().padEnd(6, '0');
  if (d.length !== 8) return null;
  const dt = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`);
  return isNaN(dt.getTime()) ? null : dt;
}

function normalizeBufferRow(row) {
  const code = String(row.NAME || '').trim();
  // En ST02 (kernel 7.x) el buffer genérico y el de registro único se muestran como una sola fila "Tables Buffer"
  if (code === 'TABLP') return null;

  const meta = BUFFER_CATALOG[code] || { group: 'SAP Buffer', label: code, parameter: 'N/A', dbBacked: true, order: 99 };

  const allocKb = Number(row.ALLOC_SIZE || 0);
  const availKb = Number(row.AVAIL_SIZE || allocKb || 0);
  const usedKb = Number(row.USED_SPACE || 0);
  const freeKb = Math.max(0, availKb - usedKb);
  const pctFreeSp = availKb > 0 ? Number(((freeKb / availKb) * 100).toFixed(2)) : 0;

  const dirSize = Number(row.MAX_OBJCTS || 0);
  const actObjects = Number(row.ACT_OBJCTS || 0);
  const freeDirEnt = Math.max(0, dirSize - actObjects);
  const pctFreeDir = dirSize > 0 ? Number(((freeDirEnt / dirSize) * 100).toFixed(2)) : 0;

  // Swaps: SWAP = objetos desplazados; SWAP_FRAME = frames desplazados (ST02 muestra frames en CUA y Export/import)
  const swapObjects = Number(row.SWAP || 0);
  const swapFrames = Number(row.SWAP_FRAME || 0);
  const swapsSt02 = swapFrames > 0 ? swapFrames : swapObjects;

  const requests = Number(row.REQUEST || 0);
  const notFound = Number(row.OBJ_N_FND || 0);

  return {
    code,
    order: meta.order,
    group: meta.group,
    label: meta.label,
    parameter: meta.parameter,
    dbBacked: meta.dbBacked,
    hitRatio: Number(parseFloat(row.HITRATIO || 0).toFixed(2)),
    allocKb,
    availKb,
    usedKb,
    freeKb,
    pctFreeSp,
    dirSize,
    actObjects,
    freeDirEnt,
    pctFreeDir,
    swapObjects,
    swapFrames,
    swaps: swapsSt02,
    dbAccesses: Number(row.DB_ACCESS || 0),
    requests,
    notFound,
    notFoundPct: requests > 0 ? Number(((notFound / requests) * 100).toFixed(2)) : 0
  };
}

function buildMemoryAreas(res) {
  const em = res.EXTENDED_MEMORY_USAGE || {};
  const eg = res.EX_GLOB_MEM_USAGE || {};
  const heap = res.HEAP_MEMORY_USAGE || {};
  const page = res.PAGING_AREA || {};
  const shr = res.SHR_OBJ_MEM_USAGE || {};
  const pct = (a, b) => (b > 0 ? Number(((a / b) * 100).toFixed(2)) : 0);

  // EXTENDED_MEMORY_USAGE viene en MB; ST02 lo presenta en KB
  const emInMemKb = Number(em.TOTAL || 0) * 1024;
  const emCurUseKb = Number(em.ALLOCATED || 0) * 1024;
  const emMaxUseKb = Number(em.USED || 0) * 1024;

  const egInMemKb = Number(eg.TOTAL || 0);
  const egCurUseKb = Number(eg.USED || 0);
  const egMaxUseKb = Number(eg.PEAK || 0);

  const pageTotalKb = Number(page.AREA_SIZE || 0);
  const pageCurUseKb = Number(page.CURR_USED || 0);
  const pageMaxUseKb = Number(page.MAX_USED || 0);
  const pageInMemKb = Number(page.AREA_SHM || 0);

  const shrAllocKb = Number(shr.ALLOC || 0);
  const shrInMemKb = shrAllocKb + Number(shr.FREE || 0);

  return [
    {
      id: 'EXTENDED_MEMORY', name: 'Extended memory', parameter: 'em/initial_size_MB',
      curUseKb: emCurUseKb, maxUseKb: emMaxUseKb, inMemKb: emInMemKb, onDiskKb: 0,
      currUsePct: pct(emCurUseKb, emInMemKb), maxUsePct: pct(emMaxUseKb, emInMemKb),
      attachedMB: Number(em.ATTACHED || 0)
    },
    {
      id: 'EXT_GLOBAL_MEMORY', name: 'Ext. global memory', parameter: 'em/global_area_MB',
      curUseKb: egCurUseKb, maxUseKb: egMaxUseKb, inMemKb: egInMemKb, onDiskKb: 0,
      currUsePct: pct(egCurUseKb, egInMemKb), maxUsePct: pct(egMaxUseKb, egInMemKb)
    },
    {
      id: 'PAGE_AREA', name: 'Page area', parameter: 'rdisp/PG_MAXFS / rdisp/PG_SHM',
      curUseKb: pageCurUseKb, maxUseKb: pageMaxUseKb, inMemKb: pageInMemKb, onDiskKb: Number(page.FILE_SIZE || 0),
      totalKb: pageTotalKb,
      currUsePct: pct(pageCurUseKb, pageTotalKb), maxUsePct: pct(pageMaxUseKb, pageTotalKb)
    },
    {
      id: 'SHARED_OBJECTS', name: 'Shared objects', parameter: 'abap/shared_objects_size_MB',
      curUseKb: shrAllocKb, maxUseKb: null, inMemKb: shrInMemKb, onDiskKb: 0,
      currUsePct: pct(shrAllocKb, shrInMemKb), maxUsePct: null
    },
    {
      id: 'HEAP_MEMORY', name: 'Heap memory', parameter: 'abap/heap_area_dia / abap/heap_area_nondia / abap/heap_area_total',
      curUseKb: Number(heap.USED || 0), maxUseKb: Number(heap.TOTAL || 0), inMemKb: null, onDiskKb: 0,
      currUsePct: null, maxUsePct: null,
      heapAreaDiaBytes: Number(heap.TOTAL_DIA || heap.QUOTA_DIA_64 || 0),
      heapAreaNonDiaBytes: Number(heap.TOTAL_NDIA || heap.QUOTA_NDIA_64 || 0)
    }
  ];
}

function extractPrivContexts(res) {
  const ctx = Array.isArray(res.EXTENDED_MEMORY_ACTIVE_CONTEXT) ? res.EXTENDED_MEMORY_ACTIVE_CONTEXT : [];
  return ctx
    .filter(c => String(c.PRIVTIME || '').trim() !== '' || Number(c.PRIVSUMKB || 0) > 0)
    .map(c => ({
      wpNo: Number(c.WPID),
      user: String(c.ROLLINFO || '').split('(')[0].trim() || '-',
      privKb: Number(c.PRIVSUMKB || 0),
      privSince: String(c.PRIVTIME || '').trim()
    }));
}

/**
 * Guarda una muestra cada 5 minutos para poder calcular deltas reales (las cifras de ST02 son acumuladas desde el arranque).
 */
function persistSample(payload) {
  const bucket = Math.floor(Date.now() / SAMPLE_BUCKET_MS);
  if (bucket === lastSampleBucket) return;
  lastSampleBucket = bucket;

  const sample = {
    buffers: Object.fromEntries(payload.buffers.map(b => [b.code, {
      swapObjects: b.swapObjects, swapFrames: b.swapFrames, dbAccesses: b.dbAccesses, actObjects: b.actObjects
    }])),
    memory: Object.fromEntries(payload.memoryAreas.map(m => [m.id, { curUseKb: m.curUseKb }]))
  };

  db.run(
    'INSERT INTO st02_samples (ts, startup, payload) VALUES (?, ?, ?)',
    [Date.now(), payload.summary.startupRaw, JSON.stringify(sample)],
    err => { if (err) console.error('[ST02 SAMPLE] Error guardando muestra:', err.message); }
  );
  db.run('DELETE FROM st02_samples WHERE ts < ?', [Date.now() - SAMPLE_RETENTION_DAYS * 86400000]);
}

/**
 * Devuelve las muestras históricas del mismo arranque de SAP (si SAP se reinicia los contadores vuelven a cero).
 */
function getSamples(startupRaw, sinceMs) {
  return new Promise(resolve => {
    db.all(
      'SELECT ts, payload FROM st02_samples WHERE startup = ? AND ts >= ? ORDER BY ts ASC',
      [startupRaw, Date.now() - sinceMs],
      (err, rows) => {
        if (err || !rows) return resolve([]);
        resolve(rows.map(r => {
          try { return { ts: r.ts, ...JSON.parse(r.payload) }; } catch (_) { return null; }
        }).filter(Boolean));
      }
    );
  });
}

function buildPayload(res, source) {
  const rawBuffers = (Array.isArray(res.BUFFER_STATISTIC_64) && res.BUFFER_STATISTIC_64.length > 0)
    ? res.BUFFER_STATISTIC_64
    : (Array.isArray(res.BUFFER_STATISTIC) ? res.BUFFER_STATISTIC : []);

  const buffers = rawBuffers.map(normalizeBufferRow).filter(Boolean).sort((a, b) => a.order - b.order);
  const memoryAreas = buildMemoryAreas(res);
  const startup = sapToDate(res.STARTUP_DATE, res.STARTUP_TIME);
  const analysisAt = sapToDate(res.ANALYSIS_DATE, res.ANALYSIS_TIME) || new Date();
  const uptimeDays = startup ? Number(((analysisAt - startup) / 86400000).toFixed(2)) : null;

  const totalHit = res.TOTAL_HITRATIO || {};
  const cursorCache = res.SAP_CURSOR_CACHE_TOTAL || {};

  return {
    source,
    fetchedAt: new Date().toISOString(),
    summary: {
      startupRaw: `${res.STARTUP_DATE || ''}${res.STARTUP_TIME || ''}`,
      startupFormatted: formatSapDateTime(res.STARTUP_DATE, res.STARTUP_TIME),
      analysisFormatted: formatSapDateTime(res.ANALYSIS_DATE, res.ANALYSIS_TIME),
      uptimeDays,
      dbDirectHitRatio: parseFloat(totalHit.DIRECT || 0),
      dbSequentialHitRatio: parseFloat(totalHit.SEQUENTIAL || 0),
      dbAverageHitRatio: parseFloat(totalHit.AVERAGE || 0),
      cursorCacheIdHitRatio: Number(parseFloat(cursorCache.ID_HITR || 0).toFixed(2)),
      cursorCacheStmtHitRatio: Number(parseFloat(cursorCache.STMT_HITR || 0).toFixed(2)),
      totalSwaps: buffers.reduce((acc, b) => acc + b.swaps, 0)
    },
    memoryAreas,
    privContexts: extractPrivContexts(res),
    buffers
  };
}

async function fetchSt02MetricsFromSap(forceRefresh = false) {
  if (process.env.SAP_LIVE !== 'true') return null;

  const now = Date.now();
  if (!forceRefresh && cachedSt02Data && (now - lastFetchTimestamp) < CACHE_TTL_MS) {
    return cachedSt02Data;
  }

  try {
    const res = await executeRfc('SAPTUNE_GET_SUMMARY_STATISTIC', {});
    const payload = buildPayload(res, 'SAP_RFC_SAPTUNE_GET_SUMMARY_STATISTIC');
    persistSample(payload);
    cachedSt02Data = payload;
    lastFetchTimestamp = now;
    return payload;
  } catch (err) {
    console.error('[ST02 SERVICE] Error consultando SAPTUNE_GET_SUMMARY_STATISTIC:', err.message);
    return cachedSt02Data || null;
  }
}

/**
 * Respaldo estático (instantánea real de BOP del 22.10.2026). Solo para visualización: NO usar para diagnóstico.
 */
function getSt02FallbackData() {
  const b = (NAME, HITRATIO, ALLOC_SIZE, AVAIL_SIZE, USED_SPACE, MAX_OBJCTS, ACT_OBJCTS, SWAP, SWAP_FRAME, DB_ACCESS, REQUEST, OBJ_N_FND = 0) =>
    ({ NAME, HITRATIO, ALLOC_SIZE, AVAIL_SIZE, USED_SPACE, MAX_OBJCTS, ACT_OBJCTS, SWAP, SWAP_FRAME, DB_ACCESS, REQUEST, OBJ_N_FND });

  const res = {
    STARTUP_DATE: '20260815', STARTUP_TIME: '234511',
    ANALYSIS_DATE: '20261022', ANALYSIS_TIME: '113337',
    BUFFER_STATISTIC_64: [
      b('TTAB', '99.99', 473789, 377654, 59912, 878906, 139434, 0, 0, 151784, 1110418578),
      b('FTAB', '99.95', 995636, 878906, 366069, 878906, 80247, 0, 0, 87353, 163596548),
      b('SNTAB', '99.99', 127373, 87891, 328, 219726, 1101, 0, 0, 1101, 12475531),
      b('IRBD', '98.77', 215263, 175781, 22842, 219726, 40019, 0, 0, 40122, 3265489),
      b('PXA', '99.92', 4157280, 3788916, 3764463, 1039320, 80142, 42204, 0, 2317659, 2811791592),
      b('CUA', '90.49', 3000, 2255, 2224, 2000, 97, 1920284, 89403758, 1927717, 40418924, 3843594),
      b('PRES', '95.77', 4297, 4093, 4070, 2000, 451, 516025, 0, 2371909, 56020294),
      b('CALE', '100.00', 586, 576, 122, 200, 156, 0, 0, 156, 1595524889, 8480),
      b('OTR', '97.20', 4096, 3355, 8, 2000, 20, 0, 0, 0, 629691, 17638),
      b('TABL', '99.96', 3191808, 3009589, 1292344, 966797, 318871, 0, 0, 5092983, 12776679229, 5087022),
      b('EIBUF', '8.43', 164823, 158761, 40865, 16482, 13734, 1086196, 9410519, 0, 11215560348, 10269023466),
      b('ESM', '99.17', 4096, 3355, 325, 2000, 3, 0, 0, 0, 1374561, 11330)
    ],
    EXTENDED_MEMORY_USAGE: { ATTACHED: 3536, ALLOCATED: 17524, USED: 26700, TOTAL: 27200 },
    EX_GLOB_MEM_USAGE: { TOTAL: '5144576', USED: '3732434', PEAK: '3743699' },
    HEAP_MEMORY_USAGE: { USED: 31124, TOTAL: 3905799, TOTAL_DIA: 2000000000, TOTAL_NDIA: 2000000000 },
    PAGING_AREA: { AREA_SHM: 263360, AREA_SIZE: 2000000, CURR_USED: 150130, MAX_USED: 1065792, FILE_SIZE: 1736640 },
    SHR_OBJ_MEM_USAGE: { ALLOC: '20712', FREE: '398744' },
    TOTAL_HITRATIO: { DIRECT: '96.04', SEQUENTIAL: '83.74', AVERAGE: '89.89' },
    SAP_CURSOR_CACHE_TOTAL: { ID_HITR: '99.74', STMT_HITR: '82' },
    EXTENDED_MEMORY_ACTIVE_CONTEXT: []
  };
  return buildPayload(res, 'FALLBACK_SNAPSHOT');
}

async function getSt02Metrics(forceRefresh = false) {
  const live = await fetchSt02MetricsFromSap(forceRefresh);
  return live || getSt02FallbackData();
}

module.exports = {
  getSt02Metrics,
  getSamples
};
