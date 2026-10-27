const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const apiRoutes = require('./routes/api');
const { db: monitorDb } = require('./services/snapshotService');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración para CORS, JSON (hasta 10mb para payloads de planta) y archivos estáticos
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================================================
// VISTAS DEL FRONTEND (Misma instancia en Puerto 3000)
// - "/"          -> Notificación SAP Producción (Planta / Microsoft SSO)
// - "/monitor"   -> Consola de Monitoreo SAP ERP (Basis / RFC Login)
// ============================================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get(['/monitor', '/dashboard'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'monitor.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// MÓDULO 1: NOTIFICACIÓN SAP PRODUCCIÓN (SAP CPI + database.sqlite)
// ============================================================================
const CPI_URL_CONSULTA = process.env.CPI_URL_CONSULTA || "https://grupo-daabon-cpi-0aq3xxyt.it-cpi013-rt.cfapps.us21.hana.ondemand.com/http/get_order_prod_qas";
const CPI_URL_NOTIF = process.env.CPI_URL_NOTIF || "https://grupo-daabon-cpi-0aq3xxyt.it-cpi013-rt.cfapps.us21.hana.ondemand.com/http/registro_notificacion_qas";
const CPI_USER = process.env.CPI_USER || "it@daabon.com.co";
const CPI_PASS = process.env.CPI_PASS || "D44b0n26*";
const authHeader = "Basic " + Buffer.from(CPI_USER + ":" + CPI_PASS).toString('base64');

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
    console.log("✅ Base de datos SQLite (Notificaciones Planta: database.sqlite) lista.");
  } catch (err) {
    console.error("❌ Error inicializando database.sqlite:", err.message);
  }
})();

// Endpoint 1 (Planta): Consultar Orden en SAP CPI
app.post('/api/orden', async (req, res) => {
  try {
    const { orden } = req.body;
    const response = await axios.post(CPI_URL_CONSULTA, { ORDEN: orden }, {
      headers: { 'Authorization': authHeader, 'Accept': 'application/json' }
    });
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
  let sapResponse, estadoLog = "ERROR CRÍTICO";

  try {
    const response = await axios.post(CPI_URL_NOTIF, payload, {
      headers: { 'Authorization': authHeader, 'Accept': 'application/json' }
    });
    sapResponse = response.data;
    const root = sapResponse.Z_AUTO_REGISTRO_NOTIFI_EXTRResponse || sapResponse;

    if (root && root.EV_RUECK) {
      let hasCogi = false;
      if (root.ET_COGI && root.ET_COGI.item) {
        let cogi = Array.isArray(root.ET_COGI.item) ? root.ET_COGI.item : [root.ET_COGI.item];
        if (cogi.length > 0) hasCogi = true;
      }
      estadoLog = hasCogi ? "ADVERTENCIA (COGI)" : "ÉXITO";
    } else {
      estadoLog = "ERROR EN SAP";
    }
  } catch (error) {
    const status = error.response ? error.response.status : 'Desconocido';
    const data = error.response ? error.response.data : error.message;
    sapResponse = {
      errorHTTP: true,
      EV_MESSAGE: `Error HTTP ${status}`,
      ET_RETURN: [{ message: typeof data === 'object' ? JSON.stringify(data) : data }]
    };
    estadoLog = "ERROR HTTP " + status;
  }

  // Insertar el registro localmente en milisegundos
  try {
    // Obtenemos la hora local restando 5 horas para zona horaria de Colombia
    const d = new Date();
    d.setHours(d.getHours() - 5);
    const fechaActual = d.toISOString().replace('T', ' ').substring(0, 19);

    const orden = (payload && payload.IV_AUFNR) || "";
    const operacion = (payload && payload.IV_VORNR) || "";
    let rueck = "";
    if (sapResponse && !sapResponse.errorHTTP) {
      const root = sapResponse.Z_AUTO_REGISTRO_NOTIFI_EXTRResponse || sapResponse;
      rueck = root.EV_RUECK || "";
    }

    if (notifDb) {
      await notifDb.run(
        `INSERT INTO logs (fecha, usuario, orden, operacion, estado, rueck, payload, respuesta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [fechaActual, usuario || "Desconocido", orden, operacion, estadoLog, rueck, JSON.stringify(payload), JSON.stringify(sapResponse)]
      );
    }
  } catch (dbError) {
    console.error("Error guardando log en SQLite:", dbError.message);
  }

  res.json(sapResponse);
});

// Endpoint 3 (Planta): Obtener Logs Filtrados
app.get('/api/logs', async (req, res) => {
  try {
    const { orden, usuario } = req.query;
    let query = `SELECT * FROM logs WHERE 1=1`;
    let params = [];

    if (orden) { query += ` AND orden LIKE ?`; params.push(`%${orden}%`); }
    if (usuario) { query += ` AND LOWER(usuario) LIKE ?`; params.push(`%${usuario.toLowerCase()}%`); }
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

// Rutas del Monitor SAP (/api/auth/*, /api/dashboard, /api/user/lock, etc.)
app.use('/api', apiRoutes);

app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(` 🚀 Servidor Unificado SAP activo en puerto ${PORT}`);
  console.log(` 📌 Vista Notificaciones Planta: http://localhost:${PORT}/`);
  console.log(` 📊 Vista Monitor SAP ERP:       http://localhost:${PORT}/monitor`);
  console.log(`====================================================`);
});
