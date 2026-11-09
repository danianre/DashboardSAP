// Configuración forzada de zona horaria de Colombia (UTC-5) para consistencia global
process.env.TZ = 'America/Bogota';

const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const cors = require('cors');
require('dotenv').config();

const apiRoutes = require('./routes/api');
const {
  db: monitorDb,
  startSnapshotDaemon,
  getSnapshotDaemonStatus
} = require('./services/snapshotService');
const {
  fetchStockByWerks,
  fetchHistoricoConsumo,
  analyzeInventoryWithAi
} = require('./services/inventoryService');
const {
  getOrSyncDataset,
  computeSalesAnalytics,
  triggerBackgroundSync
} = require('./services/salesAnalyticsService');
const {
  getOrSyncFinancialDataset,
  computeFinancialAnalytics,
  runScenarioSimulation,
  loadSavedScenarios,
  saveCustomScenario,
  deleteCustomScenario
} = require('./services/financialAnalyticsService');
const {
  getSupplyChainOverview,
  simulateSupplyChainScenario
} = require('./services/supplyChainAnalyticsService');
const {
  getFinancialRiskOverview,
  simulateFinancialRiskScenario
} = require('./services/financialRiskService');

const app = express();
const PORT = process.env.PORT || 3000;

// Metadatos de versión y commit desplegado (para trazabilidad CI/CD y reversión)
function resolveReleaseMetadata() {
  const metaPath = path.join(__dirname, '.deploy-meta.json');
  try {
    if (fs.existsSync(metaPath)) {
      return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    }
  } catch (_) {}

  let commit = process.env.GIT_COMMIT || 'unknown';
  try {
    commit = execSync('git rev-parse HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch (_) {}

  return {
    commit,
    deployedAt: new Date().toISOString()
  };
}

const releaseMeta = resolveReleaseMetadata();

// Configuración para CORS, JSON (hasta 10mb para payloads de planta) y archivos estáticos
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================================================
// REDIRECCIÓN INTELIGENTE POR DOMINIO
// - Si un usuario ingresa a notificaciones-sap.daabon.com.co en la raíz (/ o /index.html),
//   se redirige automáticamente a https://notificaciones-sap.daabon.com.co/notificaciones-sap
// - Si ingresa por apps-sap.daabon.com.co (o IP/localhost), se muestra el selector de aplicaciones en /
// ============================================================================
app.use((req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();
  if (host.includes('notificaciones-sap') && (req.path === '/' || req.path === '/index.html')) {
    const isLocalhost = host.startsWith('localhost') || host.startsWith('127.0.0.1');
    const proto = isLocalhost ? 'http' : 'https';
    const targetUrl = `${proto}://${req.headers.host}/notificaciones-sap`;
    return res.redirect(301, targetUrl);
  }
  next();
});

// ============================================================================
// VISTAS DEL FRONTEND (Plataforma Unificada SAP)
// - "/"                   -> Página Principal: Selector «Plataforma de Aplicaciones SAP»
// - "/monitor-sap"        -> Aplicación 1: Monitor SAP (Consola de Monitoreo SAP ERP)
// - "/notificaciones-sap" -> Aplicación 2: Notificaciones SAP (Planta / Microsoft SSO)
// - "/inventarios-sap"    -> Aplicación 3: Analítica Inteligente de Inventarios (RFC + IA)
// ============================================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get(['/monitor-sap', '/monitor', '/dashboard'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'monitor.html'));
});

app.get(['/notificaciones-sap', '/notificaciones'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'notificaciones.html'));
});

app.get(['/inventarios-sap', '/optimizador-inventarios', '/inventarios'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'inventarios.html'));
});

app.get(['/ventas-sap', '/analisis-ventas', '/sac-ventas'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ventas.html'));
});

app.get(['/finanzas-sap', '/desempeno-financiero', '/sac-finanzas'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'finanzas.html'));
});

app.get(['/cadena-suministro-sap', '/logistica-sap', '/sac-logistica'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cadena-suministro.html'));
});

app.get(['/riesgos-financieros-sap', '/riesgos-sap', '/sac-riesgos'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'riesgos-financieros.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// ENDPOINT DE SALUD Y TRAZABILIDAD DE DESPLIEGUE (CI/CD Healthcheck)
// ============================================================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    platform: 'Plataforma de Aplicaciones SAP',
    commit: releaseMeta.commit,
    deployedAt: releaseMeta.deployedAt,
    uptimeSeconds: Math.floor(process.uptime()),
    collectorDaemon: getSnapshotDaemonStatus(),
    routes: {
      portal: '/',
      monitorSap: '/monitor-sap',
      notificacionesSap: '/notificaciones-sap',
      inventariosSap: '/inventarios-sap',
      ventasSap: '/ventas-sap',
      finanzasSap: '/finanzas-sap',
      cadenaSuministroSap: '/cadena-suministro-sap',
      riesgosFinancierosSap: '/riesgos-financieros-sap'
    }
  });
});

// ============================================================================
// MÓDULO 1: NOTIFICACIONES SAP PRODUCCIÓN (SAP CPI + database.sqlite)
// Credenciales cargadas exclusivamente desde variables de entorno (.env)
// ============================================================================
const CPI_URL_CONSULTA = process.env.CPI_URL_CONSULTA || '';
const CPI_URL_NOTIF = process.env.CPI_URL_NOTIF || '';
const CPI_USER = process.env.CPI_USER || '';
const CPI_PASS = process.env.CPI_PASS || '';

function getCpiAuthHeader() {
  if (!CPI_USER || !CPI_PASS) return '';
  return 'Basic ' + Buffer.from(`${CPI_USER}:${CPI_PASS}`).toString('base64');
}

let notifDb;
(async () => {
  try {
    notifDb = await open({
      filename: path.join(__dirname, 'database.sqlite'),
      driver: sqlite3.Database
    });
    await notifDb.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fecha TEXT,
        usuario TEXT,
        orden TEXT,
        operacion TEXT,
        estado TEXT,
        rueck TEXT,
        payload TEXT,
        respuesta TEXT
      )
    `);
    console.log('✅ Base de datos SQLite (Notificaciones Planta: database.sqlite) lista.');
  } catch (err) {
    console.error('❌ Error inicializando database.sqlite:', err.message);
  }
})();

// Endpoint 1 (Planta): Consultar Orden en SAP CPI
app.post('/api/orden', async (req, res) => {
  try {
    if (!CPI_URL_CONSULTA || !CPI_USER || !CPI_PASS) {
      return res.json({
        errorHTTP: true,
        E_MESSAGE: 'Configuración CPI incompleta en variables de entorno (.env).'
      });
    }
    const { orden } = req.body;
    const response = await axios.post(
      CPI_URL_CONSULTA,
      { ORDEN: orden },
      { headers: { Authorization: getCpiAuthHeader(), Accept: 'application/json' } }
    );
    res.json(response.data);
  } catch (error) {
    const status = error.response ? error.response.status : 'Desconocido';
    const msj = error.response ? JSON.stringify(error.response.data) : error.message;
    res.json({ errorHTTP: true, E_MESSAGE: `Error CPI (HTTP ${status}): ${msj}` });
  }
});

// Endpoint 2 (Planta): Enviar Notificación a SAP CPI y Guardar Log
app.post('/api/notificacion', async (req, res) => {
  const { payload, usuario } = req.body;
  let sapResponse;
  let estadoLog = 'ERROR CRÍTICO';

  try {
    if (!CPI_URL_NOTIF || !CPI_USER || !CPI_PASS) {
      throw new Error('Configuración CPI incompleta en variables de entorno (.env).');
    }
    const response = await axios.post(CPI_URL_NOTIF, payload, {
      headers: { Authorization: getCpiAuthHeader(), Accept: 'application/json' }
    });
    sapResponse = response.data;
    const root = sapResponse.Z_AUTO_REGISTRO_NOTIFI_EXTRResponse || sapResponse;

    if (root && root.EV_RUECK) {
      let hasCogi = false;
      if (root.ET_COGI && root.ET_COGI.item) {
        const cogi = Array.isArray(root.ET_COGI.item) ? root.ET_COGI.item : [root.ET_COGI.item];
        if (cogi.length > 0) hasCogi = true;
      }
      estadoLog = hasCogi ? 'ADVERTENCIA (COGI)' : 'ÉXITO';
    } else {
      estadoLog = 'ERROR EN SAP';
    }
  } catch (error) {
    const status = error.response ? error.response.status : 'Desconocido';
    const data = error.response ? error.response.data : error.message;
    sapResponse = {
      errorHTTP: true,
      EV_MESSAGE: `Error HTTP ${status}`,
      ET_RETURN: [{ message: typeof data === 'object' ? JSON.stringify(data) : data }]
    };
    estadoLog = 'ERROR HTTP ' + status;
  }

  // Insertar el registro localmente en milisegundos
  try {
    const d = new Date();
    d.setHours(d.getHours() - 5);
    const fechaActual = d.toISOString().replace('T', ' ').substring(0, 19);

    const orden = (payload && payload.IV_AUFNR) || '';
    const operacion = (payload && payload.IV_VORNR) || '';
    let rueck = '';
    if (sapResponse && !sapResponse.errorHTTP) {
      const root = sapResponse.Z_AUTO_REGISTRO_NOTIFI_EXTRResponse || sapResponse;
      rueck = root.EV_RUECK || '';
    }

    if (notifDb) {
      await notifDb.run(
        `INSERT INTO logs (fecha, usuario, orden, operacion, estado, rueck, payload, respuesta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          fechaActual,
          usuario || 'Desconocido',
          orden,
          operacion,
          estadoLog,
          rueck,
          JSON.stringify(payload),
          JSON.stringify(sapResponse)
        ]
      );
    }
  } catch (dbError) {
    console.error('Error guardando log en SQLite:', dbError.message);
  }

  res.json(sapResponse);
});

// Endpoint 3 (Planta): Obtener Logs Filtrados
app.get('/api/logs', async (req, res) => {
  try {
    const { orden, usuario } = req.query;
    let query = `SELECT * FROM logs WHERE 1=1`;
    const params = [];

    if (orden) {
      query += ` AND orden LIKE ?`;
      params.push(`%${orden}%`);
    }
    if (usuario) {
      query += ` AND LOWER(usuario) LIKE ?`;
      params.push(`%${usuario.toLowerCase()}%`);
    }
    query += ` ORDER BY id DESC LIMIT 50`;

    const rows = notifDb ? await notifDb.all(query, params) : [];
    res.json({ data: rows });
  } catch (error) {
    res.json({ error: true, message: error.message });
  }
});

// ============================================================================
// MÓDULO 2: CONSOLA DE MONITOREO SAP ERP (SAP NWRFC + monitor_sap.sqlite)
// ============================================================================
monitorDb.serialize(() => {
  monitorDb.run(`CREATE TABLE IF NOT EXISTS system_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    active_sessions INTEGER,
    dia_busy_pct REAL,
    btc_busy_pct REAL,
    sm12_locks INTEGER,
    ws_errors INTEGER
  )`);

  monitorDb.run(`CREATE TABLE IF NOT EXISTS password_resets_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bname TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    source TEXT DEFAULT 'CADI_SELF_SERVICE'
  )`);
});

// ============================================================================
// MÓDULO 3: ANALÍTICA INTELIGENTE DE INVENTARIOS (SAP RFC + IA / CPI)
// Procesos: EXCESO_INV (ZFMM_STOCK_BY_WERKS) y PROYECCION_INV (ZFMM_HISTORICO_CONSUMO)
// ============================================================================
app.post('/api/inventarios/stock', async (req, res) => {
  try {
    const { matnrLow, matnrHigh, werks, werksHigh } = req.body || {};
    const data = await fetchStockByWerks({ matnrLow, matnrHigh, werks, werksHigh });
    res.json(data);
  } catch (error) {
    console.error('[ERROR POST /api/inventarios/stock]:', error.message);
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error al consultar el RFC ZFMM_STOCK_BY_WERKS en SAP.'
    });
  }
});

app.post('/api/inventarios/consumo', async (req, res) => {
  try {
    const { matnrLow, matnrHigh, werks, werksHigh } = req.body || {};
    const data = await fetchHistoricoConsumo({ matnrLow, matnrHigh, werks, werksHigh });
    res.json(data);
  } catch (error) {
    console.error('[ERROR POST /api/inventarios/consumo]:', error.message);
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error al consultar el RFC ZFMM_HISTORICO_CONSUMO en SAP.'
    });
  }
});

app.post('/api/inventarios/ai-analyze', async (req, res) => {
  try {
    const { processType, rows, filters, preferredModel } = req.body || {};
    const result = await analyzeInventoryWithAi({
      processType,
      rows,
      filters,
      preferredModel
    });
    res.json(result);
  } catch (error) {
    console.error('[ERROR POST /api/inventarios/ai-analyze]:', error.message);
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error al procesar el análisis de inventarios con Inteligencia Artificial.'
    });
  }
});

// ============================================================================
// MÓDULO 4: ANÁLISIS DE VENTAS Y PREDICCIÓN DE INGRESOS (SAP SD RFC + SAC ML)
// Tablas: VBRK, VBRP, VBAK, KNA1, TVKOT, TVTWT, TSPAT, T023T, T005U
// ============================================================================
app.get('/api/ventas/overview', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true' || req.query.refresh === '1';
    const dataset = await getOrSyncDataset(forceRefresh);
    const analytics = computeSalesAnalytics(dataset, req.query || {});
    res.json({
      success: true,
      ...analytics
    });
  } catch (error) {
    console.error('[ERROR GET /api/ventas/overview]:', error.message);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al calcular analítica comercial y predicción de ingresos SAP SD.'
    });
  }
});

app.post('/api/ventas/overview', async (req, res) => {
  try {
    const filters = { ...(req.query || {}), ...(req.body || {}) };
    const forceRefresh = Boolean(filters.refresh === true || filters.refresh === 'true');
    const dataset = await getOrSyncDataset(forceRefresh);
    const analytics = computeSalesAnalytics(dataset, filters);
    res.json({
      success: true,
      ...analytics
    });
  } catch (error) {
    console.error('[ERROR POST /api/ventas/overview]:', error.message);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al procesar filtros de analítica de ventas SAP SD.'
    });
  }
});

// ============================================================================
// MÓDULO 5: DESEMPEÑO FINANCIERO Y SIMULACIÓN DE ESCENARIOS (SAP FI/CO)
// ============================================================================
app.get('/api/finanzas/overview', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true' || req.query.refresh === '1';
    const finDataset = await getOrSyncFinancialDataset(forceRefresh);
    const analytics = await computeFinancialAnalytics(finDataset, req.query || {});
    res.json({
      success: true,
      ...analytics
    });
  } catch (error) {
    console.error('[ERROR GET /api/finanzas/overview]:', error.message);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al calcular el desempeño financiero y estado de resultados.'
    });
  }
});

app.post('/api/finanzas/overview', async (req, res) => {
  try {
    const filters = { ...(req.query || {}), ...(req.body || {}) };
    const forceRefresh = Boolean(filters.refresh === true || filters.refresh === 'true');
    const finDataset = await getOrSyncFinancialDataset(forceRefresh);
    const analytics = await computeFinancialAnalytics(finDataset, filters);
    res.json({
      success: true,
      ...analytics
    });
  } catch (error) {
    console.error('[ERROR POST /api/finanzas/overview]:', error.message);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al procesar filtros del análisis de desempeño financiero.'
    });
  }
});

app.post('/api/finanzas/simulate', async (req, res) => {
  try {
    const { filters = {}, drivers = {} } = req.body || {};
    const finDataset = await getOrSyncFinancialDataset(false);
    const analytics = await computeFinancialAnalytics(finDataset, { ...filters, drivers });
    res.json({
      success: true,
      simulation: analytics.scenarios.activeSimulation,
      scenariosList: analytics.scenarios.list
    });
  } catch (error) {
    console.error('[ERROR POST /api/finanzas/simulate]:', error.message);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al ejecutar la simulación de escenarios y Monte Carlo.'
    });
  }
});

app.get('/api/finanzas/scenarios', (req, res) => {
  try {
    res.json({
      success: true,
      scenarios: loadSavedScenarios()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || 'Error al listar escenarios financieros.'
    });
  }
});

app.post('/api/finanzas/scenarios', async (req, res) => {
  try {
    const saved = saveCustomScenario(req.body || {});
    const finDataset = await getOrSyncFinancialDataset(false);
    const analytics = await computeFinancialAnalytics(finDataset, req.body?.filters || {});
    res.json({
      success: true,
      scenario: saved,
      scenariosList: analytics.scenarios.list
    });
  } catch (error) {
    console.error('[ERROR POST /api/finanzas/scenarios]:', error.message);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al guardar el escenario financiero personalizado.'
    });
  }
});

app.delete('/api/finanzas/scenarios/:id', async (req, res) => {
  try {
    const deleted = deleteCustomScenario(req.params.id);
    const finDataset = await getOrSyncFinancialDataset(false);
    const analytics = await computeFinancialAnalytics(finDataset, {});
    res.json({
      success: true,
      deleted,
      scenariosList: analytics.scenarios.list
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || 'Error al eliminar el escenario financiero.'
    });
  }
});

// ============================================================================
// MÓDULO 6: INTELIGENCIA Y OPTIMIZACIÓN DE LA CADENA DE SUMINISTRO (SAP SCM)
// ============================================================================
app.get('/api/cadena-suministro/overview', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true' || req.query.refresh === '1';
    const data = await getSupplyChainOverview({ ...(req.query || {}), forceRefresh });
    res.json(data);
  } catch (error) {
    console.error('[ERROR GET /api/cadena-suministro/overview]:', error.message);
    res.status(500).json({
      ok: false,
      error: error.message || 'Error al calcular la inteligencia y optimización de la cadena de suministro.'
    });
  }
});

app.post('/api/cadena-suministro/overview', async (req, res) => {
  try {
    const filters = { ...(req.query || {}), ...(req.body || {}) };
    const forceRefresh = Boolean(filters.refresh === true || filters.refresh === 'true');
    const data = await getSupplyChainOverview({ ...filters, forceRefresh });
    res.json(data);
  } catch (error) {
    console.error('[ERROR POST /api/cadena-suministro/overview]:', error.message);
    res.status(500).json({
      ok: false,
      error: error.message || 'Error al procesar filtros y pesos de la cadena de suministro.'
    });
  }
});

app.post('/api/cadena-suministro/simulate', async (req, res) => {
  try {
    const { filters = {}, levers = {} } = req.body || {};
    const overview = await getSupplyChainOverview({ ...filters, customLevers: levers });
    res.json({
      ok: true,
      simulation: overview.page7SimulationAndActions.activeSimulation
    });
  } catch (error) {
    console.error('[ERROR POST /api/cadena-suministro/simulate]:', error.message);
    res.status(500).json({
      ok: false,
      error: error.message || 'Error al simular el escenario operativo de la cadena de suministro.'
    });
  }
});

// ============================================================================
// MÓDULO 7: INTELIGENCIA Y ANÁLISIS DE RIESGOS FINANCIEROS (SAP FI-AR / CREDIT)
// ============================================================================
app.get('/api/riesgos-financieros/overview', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true' || req.query.refresh === '1';
    const data = await getFinancialRiskOverview({ ...(req.query || {}), forceRefresh });
    res.json(data);
  } catch (error) {
    console.error('[ERROR GET /api/riesgos-financieros/overview]:', error.message);
    res.status(500).json({
      ok: false,
      error: error.message || 'Error al calcular el análisis de riesgos financieros y crediticios.'
    });
  }
});

app.post('/api/riesgos-financieros/overview', async (req, res) => {
  try {
    const filters = { ...(req.query || {}), ...(req.body || {}) };
    const forceRefresh = Boolean(filters.refresh === true || filters.refresh === 'true');
    const data = await getFinancialRiskOverview({ ...filters, forceRefresh });
    res.json(data);
  } catch (error) {
    console.error('[ERROR POST /api/riesgos-financieros/overview]:', error.message);
    res.status(500).json({
      ok: false,
      error: error.message || 'Error al procesar filtros del análisis de riesgos financieros.'
    });
  }
});

app.post('/api/riesgos-financieros/simulate', async (req, res) => {
  try {
    const { filters = {}, assumptions = {} } = req.body || {};
    const overview = await getFinancialRiskOverview({ ...filters, customAssumptions: assumptions });
    res.json({
      ok: true,
      simulation: overview.page7StressTestingAndActions.activeSimulation
    });
  } catch (error) {
    console.error('[ERROR POST /api/riesgos-financieros/simulate]:', error.message);
    res.status(500).json({
      ok: false,
      error: error.message || 'Error al ejecutar la simulación y prueba de estrés financiero.'
    });
  }
});

// Rutas del Monitor SAP (/api/auth/*, /api/dashboard, /api/user/lock, etc.)
app.use('/api', apiRoutes);

app.listen(PORT, () => {
  console.log(`========================================================`);
  console.log(` 🚀 Plataforma de Aplicaciones SAP activa en puerto ${PORT}`);
  console.log(` 🌐 URL Principal:        https://apps-sap.daabon.com.co/`);
  console.log(` 🏠 Selector Principal:   http://localhost:${PORT}/`);
  console.log(` 📊 Monitor SAP ERP:      http://localhost:${PORT}/monitor-sap`);
  console.log(` 🔔 Notificaciones SAP:   http://localhost:${PORT}/notificaciones-sap`);
  console.log(` 🧠 Inventarios IA:       http://localhost:${PORT}/inventarios-sap`);
  console.log(` 📈 Ventas & SAC ML:      http://localhost:${PORT}/ventas-sap`);
  console.log(` 💰 Finanzas & Escenarios:http://localhost:${PORT}/finanzas-sap`);
  console.log(` 🚚 Cadena de Suministro: http://localhost:${PORT}/cadena-suministro-sap`);
  console.log(` 🛡️ Riesgos Financieros:  http://localhost:${PORT}/riesgos-financieros-sap`);
  console.log(` 🔖 Commit Activo:        ${releaseMeta.commit}`);
  console.log(`========================================================`);

  // Iniciar servicio demonio de recolección continua 24/7 en segundo plano (cada 15 segundos)
  startSnapshotDaemon(15000);

  // Pre-calentar caché de Analítica de Ventas SAP SD en segundo plano tras el arranque
  setTimeout(() => {
    triggerBackgroundSync();
  }, 3500);
});
