#!/usr/bin/env node
/**
 * Script de Validación Pre-Despliegue (CI/CD Gatekeeper)
 * Verifica sintaxis JS, integridad de vistas del portal y ausencia de secretos expuestos.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
let errors = 0;

function fail(msg) {
  console.error(`❌ [VALIDACIÓN FALLIDA]: ${msg}`);
  errors++;
}

function pass(msg) {
  console.log(`✅ [OK]: ${msg}`);
}

// 1. Verificar sintaxis de archivos JavaScript del backend
const jsFiles = [
  'server.js',
  'config/sap.js',
  'routes/api.js',
  ...fs.readdirSync(path.join(rootDir, 'services'))
    .filter(f => f.endsWith('.js'))
    .map(f => path.join('services', f))
];

for (const relPath of jsFiles) {
  const fullPath = path.join(rootDir, relPath);
  if (!fs.existsSync(fullPath)) {
    fail(`Archivo requerido no encontrado: ${relPath}`);
    continue;
  }
  try {
    execFileSync(process.execPath, ['--check', fullPath], { stdio: 'pipe' });
    pass(`Sintaxis válida: ${relPath}`);
  } catch (err) {
    fail(`Error de sintaxis en ${relPath}: ${err.message}`);
  }
}

// 2. Verificar existencia e integridad de las 5 vistas principales
const requiredViews = [
  {
    file: 'public/index.html',
    mustContain: [
      'Plataforma de Aplicaciones SAP',
      'Monitor SAP',
      'Ingresar al monitor',
      'Notificaciones SAP',
      'Ingresar a notificaciones',
      'Optimizador de Inventarios IA',
      'Ingresar al optimizador',
      'Ventas y Predicción SAC',
      '/ventas-sap',
      'Desempeño Financiero y Simulación SAC',
      '/finanzas-sap',
      'Cadena de Suministro y Logística SAC',
      '/cadena-suministro-sap'
    ]
  },
  {
    file: 'public/monitor.html',
    mustContain: ['Centro de Monitoreo de Operación y Soporte']
  },
  {
    file: 'public/notificaciones.html',
    mustContain: ['Notificación SAP Producción', 'loginMicrosoft']
  },
  {
    file: 'public/inventarios.html',
    mustContain: [
      'Analítica Inteligente de Inventarios',
      'ZFMM_STOCK_BY_WERKS',
      'ZFMM_HISTORICO_CONSUMO',
      'EXCESO_INV',
      'PROYECCION_INV'
    ]
  },
  {
    file: 'public/ventas.html',
    mustContain: [
      'Dashboard de Análisis de Ventas y Predicción de Ingresos',
      '1. Resumen Ejecutivo',
      '2. Análisis Histórico y Comercial',
      '3. Inteligencia de Clientes (RFM)',
      '4. Productos y Demanda',
      '5. Predicción de Ingresos y Demanda (ML)',
      '/api/ventas/overview'
    ]
  },
  {
    file: 'public/finanzas.html',
    mustContain: [
      'Dashboard de Desempeño Financiero, Rentabilidad y Simulación de Escenarios',
      '1. Resumen Financiero Ejecutivo',
      '2. Estado de Resultados (P&amp;L)',
      '3. Rentabilidad por Segmento',
      '4. Análisis de Costos y Gastos',
      '5. Simulación de Escenarios &amp; Monte Carlo',
      '6. Control Presupuestal y Recomendaciones',
      '/api/finanzas/overview'
    ]
  },
  {
    file: 'public/cadena-suministro.html',
    mustContain: [
      'Inteligencia y Optimización de la Cadena de Suministro',
      '1. Resumen Ejecutivo y Alertas',
      '2. Proveedores y Abastecimiento (TCO)',
      '3. Control y Optimización de Inventarios',
      '4. Transporte, Tiempos y Costos',
      '5. Recomendador de Rutas y Flota',
      '6. Análisis Predictivo (Smart Predict)',
      '7. Simulador de Escenarios y Acciones',
      '/api/cadena-suministro/overview'
    ]
  }
];

for (const view of requiredViews) {
  const fullPath = path.join(rootDir, view.file);
  if (!fs.existsSync(fullPath)) {
    fail(`Vista requerida no encontrada: ${view.file}`);
    continue;
  }
  const content = fs.readFileSync(fullPath, 'utf8');
  for (const token of view.mustContain) {
    if (!content.includes(token)) {
      fail(`La vista ${view.file} no contiene el elemento esperado: "${token}"`);
    }
  }
  pass(`Vista verificada: ${view.file}`);
}

// 3. Verificar que no existan secretos o claves privadas en el código fuente
const forbiddenPatterns = [
  /-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----/,
  /(?:CPI_PASS|SAP_PASSWORD)\s*=\s*["'][^"']+["']/
];

for (const relPath of [...jsFiles, 'public/index.html', 'public/monitor.html', 'public/notificaciones.html', 'public/inventarios.html', 'public/ventas.html']) {
  const fullPath = path.join(rootDir, relPath);
  if (!fs.existsSync(fullPath)) continue;
  const content = fs.readFileSync(fullPath, 'utf8');
  for (const regex of forbiddenPatterns) {
    if (regex.test(content)) {
      fail(`Secreto o credencial detectada en archivo rastreado: ${relPath}`);
    }
  }
}
pass('Escaneo de secretos completado sin hallazgos expuestos.');

if (errors > 0) {
  console.error(`\n⛔ Total de errores de validación: ${errors}. Se bloquea la publicación.`);
  process.exit(1);
}

console.log('\n🎉 Todas las validaciones pre-despliegue finalizaron correctamente.');
process.exit(0);
