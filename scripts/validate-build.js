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

// 2. Verificar existencia e integridad de las 3 vistas principales
const requiredViews = [
  {
    file: 'public/index.html',
    mustContain: [
      'Plataforma de Aplicaciones SAP',
      'Monitor SAP',
      'Ingresar al monitor',
      'Notificaciones SAP',
      'Ingresar a notificaciones'
    ]
  },
  {
    file: 'public/monitor.html',
    mustContain: ['Centro de Monitoreo de Operación y Soporte']
  },
  {
    file: 'public/notificaciones.html',
    mustContain: ['Notificación SAP Producción', 'loginMicrosoft']
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

for (const relPath of [...jsFiles, 'public/index.html', 'public/monitor.html', 'public/notificaciones.html']) {
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
