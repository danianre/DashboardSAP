const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Catálogo oficial de las 23 empresas y límites de licencias SAP acordados (Suma total = 334)
const COMPANIES_CONFIG = [
  { id: 'AFD', name: 'AFD CORPORATION & CIA SCA', limit: 3, patterns: [/\bAFD\b/i] },
  { id: 'AGROINGENIUM', name: 'AGROINGENIUM', limit: 16, patterns: [/\bAGROINGENIUM\b/i] },
  { id: 'BIOCOMBUSTIBLES', name: 'BIOCOMBUSTIBLES', limit: 17, patterns: [/\bBIOCOMBUSTIBLES\b/i] },
  { id: 'CARIBBEAN', name: 'CARIBBEAN', limit: 30, patterns: [/\bCARIBBEAN\b/i] },
  { id: 'DERIVADOS', name: 'DERIVADOS Y FRACCION', limit: 2, patterns: [/\bDERIVADOS\b/i, /\bFRACCION\b/i] },
  { id: 'EL_GRAN_SINU', name: 'EL GRAN SINU', limit: 2, patterns: [/\bEL GRAN SINU\b/i, /\bGRAN SINU\b/i, /\bSINU\b/i] },
  { id: 'ELOGIA', name: 'ELOGIA', limit: 23, patterns: [/\bELOGIA\b/i] },
  { id: 'FONDAABON', name: 'FONDAABON', limit: 1, patterns: [/\bFONDAABON\b/i] },
  { id: 'GRUPALMA', name: 'GRUPALMA', limit: 6, patterns: [/\bGRUPALMA\b/i] },
  { id: 'INVERSIONES_NEW_LAND', name: 'INVERSIONES NEW LAND', limit: 1, patterns: [/\bNEW LAND\b/i] },
  { id: 'KREDIT', name: 'KREDIT', limit: 20, patterns: [/\bKREDIT\b/i, /\bCREDIGESTION\b/i] },
  { id: 'OLEOYUMA', name: 'OLEOYUMA', limit: 6, patterns: [/\bOLEOYUMA\b/i] },
  { id: 'PALMA_Y_TRABAJO', name: 'PALMA Y TRABAJO', limit: 8, patterns: [/\bPALMA Y TRABAJO\b/i, /\bPALMATRA\b/i] },
  { id: 'PALMED', name: 'PALMED', limit: 2, patterns: [/\bPALMED\b/i] },
  { id: 'SAMARIA', name: 'SAMARIA', limit: 15, patterns: [/\bSAMARIA\b/i] },
  { id: 'SUPERLOGISTICS', name: 'SUPERLOGISTICS', limit: 4, patterns: [/\bSUPERLOGISTICS\b/i, /\bSUPER LOGISTICS\b/i] },
  { id: 'SUPERPORTUARIA', name: 'SUPERPORTUARIA', limit: 3, patterns: [/\bSUPERPORTUARIA\b/i, /\bSUPER PORTUARIA\b/i] },
  { id: 'TEQUENDAMA', name: 'TEQUENDAMA', limit: 159, patterns: [/\bTEQUENDAMA\b/i, /\bTEQUEDAMA\b/i] },
  { id: 'TERLICA', name: 'TERLICA', limit: 10, patterns: [/\bTERLICA\b/i] },
  { id: 'TRADING_SERVICE', name: 'TRADING SERVICE', limit: 1, patterns: [/\bTRADING SERVICE\b/i, /\bTRADING\b/i] },
  { id: 'VOLTAJE_EMPRESARIAL', name: 'VOLTAJE EMPRESARIAL', limit: 1, patterns: [/\bVOLTAJE\b/i] },
  { id: 'ZONA_FRANCA_LAS_AMERICAS', name: 'ZONA FRANCA LAS AMÉRICAS', limit: 1, patterns: [/\bLAS AMERICAS\b/i, /\bLAS AMÉRICAS\b/i] },
  { id: 'ZONA_FRANCA_TAYRONA', name: 'ZONA FRANCA TAYRONA', limit: 3, patterns: [/\bTAYRONA\b/i] }
];

let _cachedLicenseData = null;
let _cachedMtime = 0;

/**
 * Localiza el archivo Excel de exportación de usuarios en la raíz del proyecto
 */
function resolveExcelFilePath() {
  const rootDir = path.resolve(__dirname, '..');
  const exactFile = path.join(rootDir, 'EXPORT_20261103_082644.XLSX');
  if (fs.existsSync(exactFile)) return exactFile;

  try {
    const files = fs.readdirSync(rootDir);
    const candidate = files
      .filter(f => /^EXPORT_.*\.xlsx$/i.test(f))
      .sort()
      .reverse()[0];
    if (candidate) return path.join(rootDir, candidate);
  } catch (_) {}

  return null;
}

/**
 * Descomprime y lee archivos internos de un archivo .XLSX (ZIP) de forma nativa sin dependencias
 */
function extractZipFiles(zipBuffer) {
  const files = {};
  let offset = 0;

  while (offset < zipBuffer.length - 4) {
    const sig = zipBuffer.readUInt32LE(offset);
    if (sig === 0x04034b50) { // Cabecera de archivo local
      const compMethod = zipBuffer.readUInt16LE(offset + 8);
      const compSize = zipBuffer.readUInt32LE(offset + 18);
      const nameLen = zipBuffer.readUInt16LE(offset + 26);
      const extraLen = zipBuffer.readUInt16LE(offset + 28);
      const name = zipBuffer.toString('utf8', offset + 30, offset + 30 + nameLen);

      const dataOffset = offset + 30 + nameLen + extraLen;
      const compData = zipBuffer.subarray(dataOffset, dataOffset + compSize);

      if (compMethod === 8) { // Deflate
        files[name] = zlib.inflateRawSync(compData);
      } else if (compMethod === 0) { // Sin compresión
        files[name] = compData;
      }
      offset = dataOffset + compSize;
    } else {
      offset++;
    }
  }

  return files;
}

/**
 * Parsea el archivo XLSX y extrae la lista de usuarios y datos de dirección/departamento
 */
function parseUsersFromExcel(filePath) {
  const zipBuffer = fs.readFileSync(filePath);
  const zipEntries = extractZipFiles(zipBuffer);

  // 1. Shared Strings
  const sstXml = (zipEntries['xl/sharedStrings.xml'] || '').toString('utf8');
  const strings = [];
  const sstRegex = /<si>(?:(?!<\/si>)[\s\S])*?<\/si>/g;
  let match;
  while ((match = sstRegex.exec(sstXml)) !== null) {
    const si = match[0];
    const tMatches = si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
    const text = tMatches.map(t => t.replace(/<t[^>]*>/, '').replace(/<\/t>/, '')).join('');
    strings.push(text);
  }

  // 2. Sheet 1
  const sheetXml = (zipEntries['xl/worksheets/sheet1.xml'] || '').toString('utf8');
  const rowRegex = /<row[^>]*>([\s\S]*?)<\/row>/g;
  const rawRows = [];

  while ((match = rowRegex.exec(sheetXml)) !== null) {
    const rowXml = match[1];
    const cellRegex = /<c\s+r="([A-Z]+)(\d+)"(?:\s+t="([^"]*)")?[^>]*>(?:<v>([\s\S]*?)<\/v>)?<\/c>/g;
    let cMatch;
    const rowData = {};
    while ((cMatch = cellRegex.exec(rowXml)) !== null) {
      const col = cMatch[1];
      const type = cMatch[3];
      const val = cMatch[4];
      let cellValue = val;
      if (type === 's' && val !== undefined) {
        cellValue = strings[parseInt(val, 10)] || '';
      }
      rowData[col] = cellValue || '';
    }
    rawRows.push(rowData);
  }

  const users = [];
  // Fila 0 es encabezado, empezamos desde la fila 1
  for (let i = 1; i < rawRows.length; i++) {
    const r = rawRows[i];
    const bname = String(r.A || '').trim();
    if (!bname) continue;

    users.push({
      bname,
      firstName: String(r.B || '').trim(),
      lastName: String(r.C || '').trim(),
      fullName: `${String(r.B || '').trim()} ${String(r.C || '').trim()}`.trim() || bname,
      department: String(r.D || '').trim(),
      userGroup: String(r.E || '').trim(),
      userType: String(r.F || '').trim() || 'A Diálogo',
      lockStatus: String(r.O || '').trim()
    });
  }

  return users;
}

/**
 * Normaliza una cadena de texto para comparación fonética/aproximada sin tildes ni caracteres especiales
 */
function normalizeText(str) {
  return String(str || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * Determina a cuál de las 23 empresas pertenece un departamento según coincidencia aproximada
 */
function matchCompanyByDepartment(department) {
  const clean = normalizeText(department);
  if (!clean) return null;

  for (const comp of COMPANIES_CONFIG) {
    for (const pat of comp.patterns) {
      if (pat.test(clean)) {
        return comp;
      }
    }
  }
  return null;
}

/**
 * Obtiene el reporte estructurado de distribución de licencias SAP por empresa
 */
function getLicenseDistribution() {
  const filePath = resolveExcelFilePath();
  if (!filePath) {
    throw new Error('No se encontró el archivo de exportación de usuarios SAP (EXPORT_*.XLSX) en el servidor.');
  }

  const stat = fs.statSync(filePath);
  if (_cachedLicenseData && _cachedMtime === stat.mtimeMs) {
    return _cachedLicenseData;
  }

  const users = parseUsersFromExcel(filePath);

  // Inicializar acumuladores para cada empresa
  const companyMap = new Map();
  COMPANIES_CONFIG.forEach(c => {
    companyMap.set(c.id, {
      id: c.id,
      name: c.name,
      limit: c.limit,
      assigned: 0,
      available: c.limit,
      excess: 0,
      usage_pct: 0,
      status: 'AVAILABLE',
      status_label: 'Disponible',
      users: []
    });
  });

  const otherUsers = [];

  // Clasificar cada usuario
  users.forEach(u => {
    const matched = matchCompanyByDepartment(u.department);
    if (matched) {
      const entry = companyMap.get(matched.id);
      entry.assigned++;
      entry.users.push(u);
    } else {
      otherUsers.push(u);
    }
  });

  // Calcular métricas derivadas por empresa
  let totalAssignedCompanies = 0;
  let companiesOverlimit = 0;
  let companiesAtLimit = 0;
  let companiesAvailable = 0;

  const companiesList = COMPANIES_CONFIG.map(c => {
    const data = companyMap.get(c.id);
    totalAssignedCompanies += data.assigned;

    const diff = data.assigned - data.limit;
    data.available = Math.max(0, data.limit - data.assigned);
    data.excess = Math.max(0, data.assigned - data.limit);
    data.usage_pct = data.limit > 0 ? parseFloat(((data.assigned / data.limit) * 100).toFixed(1)) : 0;

    if (diff > 0) {
      data.status = 'OVERLIMIT';
      data.status_label = `Sobrecupo (+${diff})`;
      companiesOverlimit++;
    } else if (diff === 0) {
      data.status = 'AT_LIMIT';
      data.status_label = 'Al Límite (100%)';
      companiesAtLimit++;
    } else {
      data.status = 'AVAILABLE';
      data.status_label = `Disponible (${data.available} libres)`;
      companiesAvailable++;
    }

    // Ordenar colaboradores alfabéticamente
    data.users.sort((a, b) => a.fullName.localeCompare(b.fullName));
    return data;
  });

  // Ordenar empresas: primero las que tienen sobrecupo (descendente por exceso), luego al límite, luego disponibles
  companiesList.sort((a, b) => {
    if (a.status === 'OVERLIMIT' && b.status !== 'OVERLIMIT') return -1;
    if (b.status === 'OVERLIMIT' && a.status !== 'OVERLIMIT') return 1;
    if (a.status === 'OVERLIMIT' && b.status === 'OVERLIMIT') return b.excess - a.excess;
    return b.usage_pct - a.usage_pct;
  });

  otherUsers.sort((a, b) => (a.department || '').localeCompare(b.department || ''));

  const totalLimit = COMPANIES_CONFIG.reduce((acc, c) => acc + c.limit, 0);
  const totalActiveUsers = users.length;
  const totalGlobalAvailable = Math.max(0, totalLimit - totalActiveUsers);
  const globalUsagePct = totalLimit > 0 ? parseFloat(((totalActiveUsers / totalLimit) * 100).toFixed(1)) : 0;

  const result = {
    summary: {
      total_limit: totalLimit,
      total_active_users: totalActiveUsers,
      total_assigned_companies: totalAssignedCompanies,
      total_other_users: otherUsers.length,
      total_available_global: totalGlobalAvailable,
      global_usage_pct: globalUsagePct,
      companies_count: COMPANIES_CONFIG.length,
      companies_overlimit_count: companiesOverlimit,
      companies_at_limit_count: companiesAtLimit,
      companies_available_count: companiesAvailable,
      source_file: path.basename(filePath),
      file_updated_at: new Date(stat.mtimeMs).toISOString()
    },
    companies: companiesList,
    other_accounts: {
      id: 'OTHER_ACCOUNTS',
      name: 'Otras Empresas y Cuentas Corporativas / Técnicas',
      assigned: otherUsers.length,
      users: otherUsers
    }
  };

  _cachedLicenseData = result;
  _cachedMtime = stat.mtimeMs;
  return result;
}

module.exports = {
  COMPANIES_CONFIG,
  getLicenseDistribution,
  matchCompanyByDepartment
};
