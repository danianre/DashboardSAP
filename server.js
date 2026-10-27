const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const apiRoutes = require('./routes/api');
const { db } = require('./services/snapshotService');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1. Inicialización de tablas adicionales en SQLite local

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

  db.run(`CREATE TABLE IF NOT EXISTS password_resets_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bname TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    source TEXT DEFAULT 'CADI_SELF_SERVICE'
  )`);
});

// 2. Rutas de la API
app.use('/api', apiRoutes);

app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(` Consola de Monitoreo SAP ERP activa en puerto ${PORT}`);
  console.log(` URL: http://localhost:${PORT}`);
  console.log(`====================================================`);
});