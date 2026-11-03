const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { executeRfc } = require('../config/sap');

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
let _cachedTimestamp = 0;
const CACHE_TTL_MS = 60 * 1000; // 60 segundos de caché en memoria

/**
 * Localiza el archivo Excel de exportación de usuarios en la raíz del proyecto (modo respaldo)
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
 * Parsea el archivo XLSX de respaldo y extrae la lista de usuarios
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
      lockStatus: String(r.O || '').trim(),
      validTo: '31.12.9999'
    });
  }

  return users;
}

/**
 * Consulta en TIEMPO REAL los usuarios activos y sus departamentos desde SAP ERP vía RFC
 * (Tablas USR02 + USR21 + ADCP + ADRP)
 */
async function fetchUsersFromSapLive() {
  if (process.env.SAP_LIVE !== 'true') {
    throw new Error('SAP_LIVE no está habilitado en las variables de entorno.');
  }

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  // 1. Consultar USR02 para usuarios activos (Diálogo A o Comunicación C, vigentes y sin bloqueo administrativo)
  const usr02Res = await executeRfc('RFC_READ_TABLE', {
    QUERY_TABLE: 'USR02',
    FIELDS: [
      { FIELDNAME: 'BNAME' },
      { FIELDNAME: 'GLTGB' },
      { FIELDNAME: 'USTYP' },
      { FIELDNAME: 'UFLAG' }
    ],
    DELIMITER: '|'
  });

  const activeUsersMap = new Map();
  (usr02Res.DATA || []).forEach(d => {
    const [bname, gltgb, ustyp, uflagStr] = (d.WA || '').split('|').map(s => s.trim());
    const uflag = parseInt(uflagStr || '0', 10);
    const isNotExpired = gltgb >= today || gltgb === '00000000';
    const isDialogOrComm = ustyp === 'A' || ustyp === 'C';

    if (isDialogOrComm && isNotExpired && uflag === 0) {
      let formattedDate = '31.12.9999';
      if (gltgb && gltgb !== '00000000' && gltgb.length === 8) {
        formattedDate = `${gltgb.slice(6, 8)}.${gltgb.slice(4, 6)}.${gltgb.slice(0, 4)}`;
      }
      activeUsersMap.set(bname, {
        bname,
        validTo: formattedDate,
        userType: ustyp === 'A' ? 'A Diálogo' : (ustyp === 'C' ? 'C Comunicación' : ustyp),
        lockStatus: '',
        department: '',
        fullName: bname
      });
    }
  });

  if (activeUsersMap.size === 0) {
    throw new Error('No se obtuvieron usuarios activos desde USR02');
  }

  // 2. Consultar USR21 para relacionar BNAME con PERSNUMBER y ADDRNUMBER
  const usr21Res = await executeRfc('RFC_READ_TABLE', {
    QUERY_TABLE: 'USR21',
    FIELDS: [
      { FIELDNAME: 'BNAME' },
      { FIELDNAME: 'PERSNUMBER' },
      { FIELDNAME: 'ADDRNUMBER' }
    ],
    DELIMITER: '|'
  });

  const persToBname = new Map();
  (usr21Res.DATA || []).forEach(d => {
    const [bname, pers, addr] = (d.WA || '').split('|').map(s => s.trim());
    if (activeUsersMap.has(bname)) {
      persToBname.set(pers, bname);
      const u = activeUsersMap.get(bname);
      u.persnumber = pers;
      u.addrnumber = addr;
    }
  });

  // 3. Consultar ADCP para obtener Departamento (filtrando por la dirección central de usuarios de Daabon)
  const adcpRes = await executeRfc('RFC_READ_TABLE', {
    QUERY_TABLE: 'ADCP',
    FIELDS: [
      { FIELDNAME: 'PERSNUMBER' },
      { FIELDNAME: 'DEPARTMENT' }
    ],
    OPTIONS: [{ TEXT: "ADDRNUMBER = '0000023396'" }],
    DELIMITER: '|'
  });

  (adcpRes.DATA || []).forEach(d => {
    const [pers, dept] = (d.WA || '').split('|').map(s => s.trim());
    const bname = persToBname.get(pers);
    if (bname && activeUsersMap.has(bname)) {
      activeUsersMap.get(bname).department = dept;
    }
  });

  // 4. Consultar ADRP para nombres y apellidos completos
  const adrpRes = await executeRfc('RFC_READ_TABLE', {
    QUERY_TABLE: 'ADRP',
    FIELDS: [
      { FIELDNAME: 'PERSNUMBER' },
      { FIELDNAME: 'NAME_TEXT' },
      { FIELDNAME: 'NAME_FIRST' },
      { FIELDNAME: 'NAME_LAST' }
    ],
    DELIMITER: '|'
  });

  (adrpRes.DATA || []).forEach(d => {
    const [pers, nameText, nameFirst, nameLast] = (d.WA || '').split('|').map(s => s.trim());
    const bname = persToBname.get(pers);
    if (bname && activeUsersMap.has(bname)) {
      const u = activeUsersMap.get(bname);
      const nameParts = [nameFirst, nameLast].filter(Boolean).join(' ');
      u.fullName = nameText || nameParts || bname;
      u.firstName = nameFirst || '';
      u.lastName = nameLast || '';
    }
  });

  return Array.from(activeUsersMap.values());
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

  for (const company of COMPANIES_CONFIG) {
    for (const pattern of company.patterns) {
      if (pattern.test(clean)) {
        return company;
      }
    }
  }

  // Búsqueda aproximada secundaria por fragmentos clave
  for (const company of COMPANIES_CONFIG) {
    const normName = normalizeText(company.name);
    const keywords = normName.split(/\s+/).filter(w => w.length >= 4 && !['CORP', 'CORPO', 'CORPORATION', 'CIA', 'SCA', 'DEL', 'LAS', 'LOS'].includes(w));
    if (keywords.length > 0) {
      const matchFound = keywords.some(kw => clean.includes(kw));
      if (matchFound) {
        return company;
      }
    }
  }

  return null;
}

/**
 * Procesa la lista de usuarios y clasifica por empresa y cuotas
 */
function processUserDistribution(users, sourceInfo) {
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
    data.users.sort((a, b) => (a.fullName || a.bname).localeCompare(b.fullName || b.bname));
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

  return {
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
      source_file: sourceInfo.sourceFile,
      source_type: sourceInfo.sourceType,
      is_live: sourceInfo.isLive,
      file_updated_at: sourceInfo.updatedAt
    },
    companies: companiesList,
    other_accounts: {
      id: 'OTHER_ACCOUNTS',
      name: 'Otras Empresas y Cuentas Corporativas / Técnicas',
      assigned: otherUsers.length,
      users: otherUsers
    }
  };
}

/**
 * Obtiene la distribución de licencias SAP por empresa.
 * Prioriza conexión en tiempo real con SAP vía RFC y cuenta con respaldo automático en Excel.
 *
 * @param {boolean} forceRefresh - Forzar actualización ignorando caché
 */
async function getLicenseDistribution(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _cachedLicenseData && (now - _cachedTimestamp < CACHE_TTL_MS)) {
    return _cachedLicenseData;
  }

  let users = null;
  let sourceInfo = {
    sourceFile: 'SAP ERP RFC (USR02 / USR21 / ADCP / ADRP)',
    sourceType: 'SAP_LIVE',
    isLive: true,
    updatedAt: new Date().toISOString()
  };

  // 1. Intentar extracción en vivo desde SAP
  if (process.env.SAP_LIVE === 'true') {
    try {
      users = await fetchUsersFromSapLive();
      console.log(`[LICENSE SERVICE] Extracción en vivo exitosa: ${users.length} usuarios activos en SAP.`);
    } catch (sapErr) {
      console.warn('[LICENSE SERVICE] Conexión en vivo a SAP no disponible o falló:', sapErr.message);
      users = null;
    }
  }

  // 2. Si no se pudo obtener de SAP (ej. modo simulación o error de red), recurrir al archivo Excel
  if (!users || users.length === 0) {
    const filePath = resolveExcelFilePath();
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error('No se pudo obtener información de licencias en vivo de SAP ni se encontró archivo Excel de respaldo.');
    }
    const stat = fs.statSync(filePath);
    users = parseUsersFromExcel(filePath);
    sourceInfo = {
      sourceFile: path.basename(filePath),
      sourceType: 'EXCEL_BACKUP',
      isLive: false,
      updatedAt: new Date(stat.mtimeMs).toISOString()
    };
    console.log(`[LICENSE SERVICE] Usando archivo Excel de respaldo (${users.length} usuarios).`);
  }

  const result = processUserDistribution(users, sourceInfo);
  _cachedLicenseData = result;
  _cachedTimestamp = now;

  return result;
}

module.exports = {
  COMPANIES_CONFIG,
  getLicenseDistribution,
  matchCompanyByDepartment,
  fetchUsersFromSapLive
};
