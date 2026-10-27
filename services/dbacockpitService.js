const { executeRfc } = require('../config/sap');

let cachedDbaData = null;
let lastDbaFetchTs = 0;
const DBA_CACHE_TTL_MS = 30000; // 30 s de caché para proteger el pool RFC

// Catálogo de descripciones funcionales fiables en español para programas/transacciones conocidos en BOP
const PROGRAM_DESCRIPTIONS = {
  '/QTQVC/READ_DATA': 'Extracción masiva de datos Qlik Connector (RFC)',
  '/QTQVC/SAPLCONNECTOR': 'Conector QlikView / Qlik Sense — Control de jobs de extracción',
  'SAPLZF_APP': 'Grupo de funciones Z de aplicación logística (consulta sobre MSEG)',
  'SIW=======ZWS_REPORTE_MOV_MERC': 'Web Service Z de reporte de movimientos de mercancía (MM)',
  'RSBTONEJOB2': 'Ejecución de jobs de facturación electrónica (eDocument)',
  'CL_EDOC_SELECTION=============CP': 'Selección de documentos electrónicos (SAP eDocument)',
  'CL_EDOCUMENT_DB===============CP': 'Acceso a base de datos de SAP eDocument (tabla EDOCUMENT)',
  'ZCL_EDOC_AIF_RUNTIME_METHODS==CP': 'Clase Z de actualización de mensajes eDocument AIF (EDOAIFMSG)',
  '/AIF/CL_INDEX_TABLE_BUFFER====CP': 'Buffer de tablas de índice SAP Application Interface Framework (AIF)',
  'SAPL3008': 'Funciones estándar FI de partidas contables (BKPF / BSIK / BSAK)',
  'SAPLME07': 'Lectura de historial de pedido de compras MM (tabla EKBE)',
  'RSWUWFML2': 'Job estándar de notificación de mensajes SAP Business Workflow',
  'RSAL_BATCH_TOOL_DISPATCHING': 'Despachador de recolectores de monitoreo CCMS (ST03/RZ20)',
  'SAPMSSY1': 'Ejecución de llamadas remotas RFC (contenedor del kernel ABAP)',
  'RPTIME00': 'Evaluación de tiempos de Gestión de Personal (HR Time Evaluation)',
  'FAGLL03': 'Partidas individuales de cuentas de mayor (Nueva Contabilidad General FI-GL)',
  'ME2L': 'Listado de documentos de compras por proveedor (MM)',
  'ME28': 'Liberación colectiva de pedidos de compra (MM)',
  'MB1A': 'Salida de mercancías de almacén (MM-IM)',
  'EDOC_COCKPIT': 'Cockpit de monitorización de Facturación Electrónica (eDocument)',
  'F-58': 'Pago con impresión de cheque / orden de pago (FI-AP)',
  'PA61': 'Actualización de datos de tiempos de personal (HR-PA)',
  'SAPLBSVA': 'Gestión de status de objetos de negocio SAP (tabla JEST)',
  'SAPLZGFHR_IT': 'Grupo de funciones Z de Gestión Humana (consulta infotipo PA2006)',
  'lsphp': 'Llamada RFC externa desde portal PHP / aplicación web integrada'
};

// Cuentas técnicas o de sistema (para no confundirlas con usuarios finales individuales)
const TECHNICAL_USERS = {
  QLIK: { role: 'Cuenta técnica BI (Qlik Connector)', shared: true },
  CONEXION: { role: 'Cuenta técnica de integración (Web Services / PHP)', shared: true },
  DDIC: { role: 'Usuario estándar de sistema / Diccionario y CCMS', shared: true },
  WORKFLOW: { role: 'Usuario técnico de ejecución de SAP Workflow', shared: true },
  SAPSYS: { role: 'Proceso interno del Kernel SAP (AutoABAP)', shared: true }
};

function formatYmd(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}${m}-${d}`.replace('-', '');
}

function formatSapDate(dStr, tStr = '') {
  const d = String(dStr || '').trim();
  const t = String(tStr || '').trim();
  if (d.length !== 8) return d || '--';
  const base = `${d.slice(6, 8)}.${d.slice(4, 6)}.${d.slice(0, 4)}`;
  if (t.length !== 6) return base;
  return `${base} ${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
}

function parseStuoTable(res) {
  const cols = (res?.ORASYSTABHEAD || []).map(h => String(h.ZEILE || '').trim());
  const vals = (res?.ORASYSTAB || []).map(r => String(r.ZEILE || '').trim());
  if (!cols.length) return [];
  const rows = [];
  for (let i = 0; i + cols.length <= vals.length; i += cols.length) {
    const obj = {};
    cols.forEach((c, idx) => { obj[c] = vals[i + idx]; });
    rows.push(obj);
  }
  return rows;
}

function sanitizeSqlText(sqlText) {
  const clean = String(sqlText || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'No disponible';
  // Reemplazar posibles literales entre comillas simples por marcador para no exponer datos sensibles
  const masked = clean.replace(/'[^']*'/g, "'?'");
  return masked.length > 180 ? `${masked.slice(0, 177)}...` : masked;
}

function extractMainTableFromSql(sqlText) {
  const s = String(sqlText || '');
  const m = s.match(/(?:FROM|INTO|UPDATE)\s+"?([A-Z0-9_/$]+)"?/i);
  return m ? m[1].toUpperCase() : null;
}

function parseEntryId(raw) {
  const s = String(raw || '');
  const typeFlag = s.length >= 73 ? s[72].trim() : '';
  const firstPart = s.slice(0, 40).trim();
  const secondPart = s.slice(40, 72).trim();
  const code = firstPart || s.slice(0, 72).trim();
  const jobOrSub = secondPart && secondPart !== firstPart ? secondPart : '';
  const kindMap = { T: 'Transacción', R: 'Reporte / Job', W: 'Web Service', F: 'Función RFC', B: 'Batch' };
  return {
    code: code === '?' ? 'RFC_SIN_PROGRAMA_ABAP' : code,
    subName: jobOrSub,
    kindCode: typeFlag || 'T',
    kindLabel: kindMap[typeFlag] || 'Ejecución ABAP'
  };
}

/**
 * Procesa los agregados de carga de trabajo de ST03N (SWNC_COLLECTOR_GET_AGGREGATES)
 * y los cruza con las sentencias costosas de V$SQLAREA.
 */
function buildWorkloadModels(swnc, sqlStatements, periodKey, periodLabel) {
  const userTcodeRows = Array.isArray(swnc?.USERTCODE) ? swnc.USERTCODE : [];
  const hitlistDb = Array.isArray(swnc?.HITLIST_DATABASE) ? swnc.HITLIST_DATABASE : [];
  const timeRows = Array.isArray(swnc?.TIMES) ? swnc.TIMES : [];

  // Mapa de programa/módulo -> usuarios observados en HITLIST_DATABASE y tablas afectadas
  const moduleToUsers = new Map();
  const tableToUsers = new Map();
  hitlistDb.forEach(h => {
    const u = String(h.ACCOUNT || '').trim();
    const rep = String(h.REPORT || '').trim();
    const tc = String(h.TCODE || '').trim();
    if (u && rep) {
      if (!moduleToUsers.has(rep)) moduleToUsers.set(rep, new Set());
      moduleToUsers.get(rep).add(u);
    }
    if (u && tc) {
      if (!moduleToUsers.has(tc)) moduleToUsers.set(tc, new Set());
      moduleToUsers.get(tc).add(u);
    }
    [h.TABNAME1, h.TABNAME2, h.TABNAME3].forEach(tb => {
      const tName = String(tb || '').trim();
      if (u && tName) {
        if (!tableToUsers.has(tName)) tableToUsers.set(tName, new Set());
        tableToUsers.get(tName).add(u);
      }
    });
  });

  // Agrupar por Usuario SAP (Panel A) y por Programa/Transacción (Panel B)
  const usersMap = new Map();
  const progsMap = new Map();

  for (const r of userTcodeRows) {
    const sapUser = String(r.ACCOUNT || '').trim() || 'SIN_ATRIBUCION';
    const { code: progCode, subName, kindLabel } = parseEntryId(r.ENTRY_ID);
    const displayProg = subName ? `${progCode} (${subName})` : progCode;

    const steps = Number(r.COUNT || 0);
    const respMs = Number(r.RESPTI || 0);
    const cpuMs = Number(r.CPUTI || 0);
    const dbReadDirMs = Number(r.READDIRTI || 0);
    const dbReadSeqMs = Number(r.READSEQTI || 0);
    const dbChgMs = Number(r.CHNGTI || 0);
    const dbProcMs = Number(r.DBP_TIME || 0);
    const dbTimeMs = dbReadDirMs + dbReadSeqMs + dbChgMs + dbProcMs;

    const logicalReads = Number(r.READDIRCNT || 0) + Number(r.READSEQCNT || 0) + Number(r.READDIRBUF || 0) + Number(r.READSEQBUF || 0);
    const physReads = Number(r.PHYREADCNT || 0);
    const dbWrites = Number(r.CHNGCNT || 0);
    const physWrites = Number(r.PHYCHNGREC || 0);

    // Acumular usuario
    if (!usersMap.has(sapUser)) {
      const techMeta = TECHNICAL_USERS[sapUser];
      usersMap.set(sapUser, {
        sapUser,
        dbUser: 'SAPSR3',
        userType: techMeta ? techMeta.role : 'Usuario de aplicación SAP',
        isSharedAccount: Boolean(techMeta?.shared),
        executions: 0,
        dbTimeSec: 0,
        cpuTimeSec: 0,
        respTimeSec: 0,
        logicalReads: 0,
        physicalReads: 0,
        dbWrites: 0,
        physicalWrites: 0,
        topProgram: '',
        topProgramCode: '',
        topProgramDbMs: -1,
        programsSet: new Set()
      });
    }
    const u = usersMap.get(sapUser);
    u.executions += steps;
    u.dbTimeSec += dbTimeMs / 1000;
    u.cpuTimeSec += cpuMs / 1000;
    u.respTimeSec += respMs / 1000;
    u.logicalReads += logicalReads;
    u.physicalReads += physReads;
    u.dbWrites += dbWrites;
    u.physicalWrites += physWrites;
    if (progCode) u.programsSet.add(progCode);
    if (dbTimeMs > u.topProgramDbMs && displayProg) {
      u.topProgramDbMs = dbTimeMs;
      u.topProgram = displayProg;
      u.topProgramCode = progCode;
    }

    // Acumular programa / transacción
    const progKey = displayProg;
    if (!progsMap.has(progKey)) {
      progsMap.set(progKey, {
        program: displayProg,
        baseCode: progCode,
        subName,
        kind: kindLabel,
        descriptionEs: PROGRAM_DESCRIPTIONS[progCode] || PROGRAM_DESCRIPTIONS[subName] || 'Programa / Transacción ejecutada en SAP',
        executions: 0,
        dbTimeSec: 0,
        cpuTimeSec: 0,
        respTimeSec: 0,
        logicalReads: 0,
        physicalReads: 0,
        dbWrites: 0,
        usersSet: new Set()
      });
    }
    const p = progsMap.get(progKey);
    p.executions += steps;
    p.dbTimeSec += dbTimeMs / 1000;
    p.cpuTimeSec += cpuMs / 1000;
    p.respTimeSec += respMs / 1000;
    p.logicalReads += logicalReads;
    p.physicalReads += physReads;
    p.dbWrites += dbWrites;
    if (sapUser) {
      p.usersSet.add(sapUser);
      if (!moduleToUsers.has(progCode)) moduleToUsers.set(progCode, new Set());
      moduleToUsers.get(progCode).add(sapUser);
    }
  }

  // Enriquecer Usuarios con consultas SQL asociadas, prioridad y explicación
  const users = Array.from(usersMap.values()).map(u => {
    const dbTimeSec = Number(u.dbTimeSec.toFixed(1));
    const cpuTimeSec = Number(u.cpuTimeSec.toFixed(1));
    const avgDbMs = u.executions > 0 ? Number(((u.dbTimeSec * 1000) / u.executions).toFixed(1)) : 0;

    // Buscar sentencias SQL de V$SQLAREA asociadas a los programas de este usuario
    const relatedSql = sqlStatements.filter(s => {
      if (u.sapUser === 'QLIK' && s.module.includes('/QTQVC/')) return true;
      if (u.sapUser === 'CONEXION' && (s.module === 'SAPLZF_APP' || s.table === 'MSEG')) return true;
      if (u.sapUser === 'LQUINTERO' && (s.module.includes('EDOC') || s.module.includes('AIF'))) return true;
      return u.programsSet.has(s.module);
    }).slice(0, 3).map(s => `${s.sqlId} (${s.table || s.module})`);

    let status = 'OK';
    if (dbTimeSec >= 5000 || cpuTimeSec >= 5000 || u.physicalReads >= 50000000) status = 'CRITICAL';
    else if (dbTimeSec >= 1000 || cpuTimeSec >= 500 || u.physicalReads >= 500000) status = 'WARNING';

    let explanation = 'Consumo dentro de parámetros operativos normales.';
    if (u.sapUser === 'QLIK') {
      explanation = 'Mayor consumidor global de CPU y lecturas físicas por extracciones masivas continuas (/QTQVC/READ_DATA) y polling sobre /QTQVC/CONTROL.';
    } else if (u.sapUser === 'LQUINTERO') {
      explanation = 'Alto tiempo acumulado en BD por jobs de fondo de Facturación Electrónica (SEND_EMAIL_EDOCUMENT_JOB / SAPMSSY1); bajo consumo de CPU pero alta espera de respuesta.';
    } else if (u.sapUser === 'CONEXION') {
      explanation = 'Cuenta técnica compartida de integración (Web Service ZWS_REPORTE_MOV_MERC y lsphp). La carga proviene de múltiples llamadas externas, no de un usuario humano individual.';
    } else if (u.isSharedAccount) {
      explanation = 'Cuenta técnica de sistema. Agrupa ejecuciones automáticas de fondo.';
    } else if (status !== 'OK') {
      explanation = `Usuario final con carga elevada en ${u.topProgram} (${avgDbMs} ms de BD promedio por paso).`;
    }

    return {
      sapUser: u.sapUser,
      dbUser: u.dbUser,
      userType: u.userType,
      isSharedAccount: u.isSharedAccount,
      executions: u.executions,
      dbTimeSec,
      avgDbMs,
      cpuTimeSec,
      logicalReads: u.logicalReads,
      physicalReads: u.physicalReads,
      dbWrites: u.dbWrites,
      topProgram: u.topProgram || 'No disponible',
      associatedSql: relatedSql.length > 0 ? relatedSql.join(', ') : 'Sin traza directa en V$SQLAREA (conexión pool SAPSR3)',
      status,
      explanation
    };
  });

  // Enriquecer Programas/Transacciones (Panel B)
  const programs = Array.from(progsMap.values()).map(p => {
    const dbTimeSec = Number(p.dbTimeSec.toFixed(1));
    const cpuTimeSec = Number(p.cpuTimeSec.toFixed(1));
    const avgDbMs = p.executions > 0 ? Number(((p.dbTimeSec * 1000) / p.executions).toFixed(1)) : 0;
    const usersArr = Array.from(p.usersSet);

    // Clasificar patrón: alto costo por ejecución vs alta frecuencia de ejecución
    let loadPattern = 'Carga balanceada';
    if (avgDbMs >= 5000 && p.executions < 500) {
      loadPattern = 'Alto costo por ejecución individual';
    } else if (p.executions >= 3000) {
      loadPattern = 'Alta frecuencia de ejecuciones repetidas';
    } else if (avgDbMs >= 1000) {
      loadPattern = 'Costo moderado-alto por ejecución';
    }

    const relatedSql = sqlStatements.filter(s => {
      if (p.baseCode.includes('/QTQVC/') && s.module.includes('/QTQVC/')) return true;
      if (p.baseCode.includes('ZWS_REPORTE_MOV_MERC') && s.module === 'SAPLZF_APP') return true;
      if ((p.subName.includes('EDOCUMENT') || p.baseCode.includes('EDOC')) && (s.module.includes('EDOC') || s.module.includes('AIF'))) return true;
      return s.module === p.baseCode;
    }).slice(0, 2).map(s => `${s.sqlId} (${s.table || 'SQL'})`);

    let status = 'OK';
    if (dbTimeSec >= 5000 || cpuTimeSec >= 5000 || p.physicalReads >= 10000000) status = 'CRITICAL';
    else if (dbTimeSec >= 1000 || avgDbMs >= 5000 || p.physicalReads >= 500000) status = 'WARNING';

    let probableCause = 'Operación estándar acorde al volumen de pasos.';
    let recommendation = 'Mantener en vigilancia preventiva.';

    if (p.baseCode.includes('/QTQVC/') || p.baseCode === 'RFC_SIN_PROGRAMA_ABAP') {
      probableCause = 'Extracciones masivas frecuentes desde Qlik hacia tablas transaccionales SAP con alto escaneo físico.';
      recommendation = 'Revisar frecuencia de recarga en Qlik, aplicar cargas incrementales (delta) y verificar sentencia 31fq4tdz5s7xr en ST04.';
    } else if (p.subName.includes('EDOCUMENT') || p.baseCode === 'EDOC_COCKPIT') {
      probableCause = 'Consultas y actualizaciones sobre tablas EDOCUMENT / EDOAIFMSG / ZEDOAIFIDXREQ con alto tiempo medio por paso.';
      recommendation = 'Revisar índices secundarios y estadísticas Oracle de EDOCUMENT y EDOAIFMSG en DB02 / ST04.';
    } else if (p.baseCode.includes('ZWS_REPORTE_MOV_MERC')) {
      probableCause = 'Invocaciones del Web Service de movimientos de mercancía que consultan MSEG (SAPLZF_APP, SQL btm9skpdzjpgn).';
      recommendation = 'Auditar en SE37/SE80 el grupo SAPLZF_APP (línea 5250) para acotar filtros sobre MSEG o usar índice por fecha/material.';
    } else if (p.baseCode === 'SAPMSSY1') {
      probableCause = 'Contenedor genérico de ejecuciones RFC entrantes de larga duración.';
      recommendation = 'Desglosar en ST03N -> RFC Profiles las funciones remotas específicas invocadas por LQUINTERO.';
    } else if (avgDbMs >= 2000) {
      probableCause = `Cada paso demora en promedio ${avgDbMs.toLocaleString('es-CO')} ms en base de datos.`;
      recommendation = 'Capturar traza ST05 o revisar plan de ejecución en ST04 para las tablas consultadas.';
    }

    return {
      program: p.program,
      baseCode: p.baseCode,
      kind: p.kind,
      descriptionEs: p.descriptionEs,
      usersText: usersArr.length > 3 ? `${usersArr.slice(0, 3).join(', ')} (+${usersArr.length - 3})` : (usersArr.join(', ') || 'No disponible'),
      usersList: usersArr,
      executions: p.executions,
      dbTimeSec,
      avgDbMs,
      cpuTimeSec,
      logicalReads: p.logicalReads,
      physicalReads: p.physicalReads,
      dbWrites: p.dbWrites,
      loadPattern,
      associatedSql: relatedSql.length ? relatedSql.join(', ') : 'No expuesto en top V$SQLAREA',
      status,
      probableCause,
      recommendation
    };
  });

  // Evolución horaria (Panel E) a partir de SWNC TIMES
  const hourlyMap = new Map();
  for (const t of timeRows) {
    const slot = String(t.TIME || '').trim();
    if (!slot) continue;
    if (!hourlyMap.has(slot)) {
      hourlyMap.set(slot, { slot, executions: 0, dbTimeSec: 0, cpuTimeSec: 0, logicalReads: 0, physicalReads: 0, dbWrites: 0 });
    }
    const h = hourlyMap.get(slot);
    h.executions += Number(t.COUNT || 0);
    const dbMs = Number(t.READDIRTI || 0) + Number(t.READSEQTI || 0) + Number(t.CHNGTI || 0) + Number(t.DBP_TIME || 0);
    h.dbTimeSec += dbMs / 1000;
    h.cpuTimeSec += Number(t.CPUTI || 0) / 1000;
    h.logicalReads += Number(t.READDIRCNT || 0) + Number(t.READSEQCNT || 0) + Number(t.READDIRBUF || 0) + Number(t.READSEQBUF || 0);
    h.physicalReads += Number(t.PHYREADCNT || 0);
    h.dbWrites += Number(t.CHNGCNT || 0);
  }

  const hourly = Array.from(hourlyMap.values())
    .sort((a, b) => a.slot.localeCompare(b.slot))
    .map(h => ({
      ...h,
      dbTimeSec: Number(h.dbTimeSec.toFixed(1)),
      cpuTimeSec: Number(h.cpuTimeSec.toFixed(1))
    }));

  const totals = users.reduce((acc, u) => {
    acc.executions += u.executions;
    acc.dbTimeSec += u.dbTimeSec;
    acc.cpuTimeSec += u.cpuTimeSec;
    acc.logicalReads += u.logicalReads;
    acc.physicalReads += u.physicalReads;
    acc.dbWrites += u.dbWrites;
    return acc;
  }, { executions: 0, dbTimeSec: 0, cpuTimeSec: 0, logicalReads: 0, physicalReads: 0, dbWrites: 0 });

  return {
    periodKey,
    periodLabel,
    totals: {
      ...totals,
      dbTimeSec: Number(totals.dbTimeSec.toFixed(1)),
      cpuTimeSec: Number(totals.cpuTimeSec.toFixed(1))
    },
    users,
    programs,
    hourly,
    moduleToUsers,
    tableToUsers
  };
}

/**
 * Construye el modelo de Sentencias SQL más costosas (Panel C) desde V$SQLAREA.
 */
function buildSqlStatementsModel(rawRows, moduleToUsers, tableToUsers) {
  const byId = new Map();
  for (const r of rawRows) {
    if (!r.SQL_ID) continue;
    byId.set(r.SQL_ID, r);
  }

  return Array.from(byId.values()).map(r => {
    const sqlId = r.SQL_ID;
    const module = String(r.MODULE || '').trim() || 'Oracle Interno / Sin módulo ABAP';
    const action = String(r.ACTION || '').trim();
    const moduleAction = action ? `${module} (lín. ${action})` : module;
    const dbUser = String(r.PARSING_SCHEMA_NAME || 'SAPSR3').trim();
    const executions = Number(r.EXECUTIONS || 0);
    const elapsedSec = Number((Number(r.ELAPSED_TIME || 0) / 1e6).toFixed(1));
    const avgElapsedMs = executions > 0 ? Number(((Number(r.ELAPSED_TIME || 0) / 1000) / executions).toFixed(2)) : 0;
    const cpuSec = Number((Number(r.CPU_TIME || 0) / 1e6).toFixed(1));
    const logicalReads = Number(r.BUFFER_GETS || 0);
    const physicalReads = Number(r.DISK_READS || 0);
    const directWrites = Number(r.DIRECT_WRITES || 0) + Number(r.PHYSICAL_WRITE_REQUESTS || 0);
    const rowsProcessed = Number(r.ROWS_PROCESSED || 0);
    const appWaitMs = Number((Number(r.APPLICATION_WAIT_TIME || 0) / 1000).toFixed(1));
    const concWaitMs = Number((Number(r.CONCURRENCY_WAIT_TIME || 0) / 1000).toFixed(1));
    const ioWaitSec = Number((Number(r.USER_IO_WAIT_TIME || 0) / 1e6).toFixed(1));
    const memKb = Math.round((Number(r.SHARABLE_MEM || 0) + Number(r.PERSISTENT_MEM || 0) + Number(r.RUNTIME_MEM || 0)) / 1024);
    const sqlText = sanitizeSqlText(r.SQL_TEXT || r.SQL_FULLTEXT);
    const table = extractMainTableFromSql(sqlText);

    // Atribución honesta de usuario SAP: V$SQLAREA solo guarda PARSING_SCHEMA_NAME (SAPSR3).
    // Cruzamos con HITLIST_DATABASE/USERTCODE cuando el módulo/tabla permite identificar usuarios; si es compartido lo indicamos expresamente.
    let sapUserAttribution = 'No identificable individualmente en V$SQLAREA (esquema compartido SAPSR3)';
    if (module.includes('/QTQVC/')) {
      sapUserAttribution = 'QLIK (evidencia por módulo /QTQVC/)';
    } else if (module === 'SAPLZF_APP') {
      sapUserAttribution = 'CONEXION (vía Web Service ZWS_REPORTE_MOV_MERC)';
    } else if (moduleToUsers?.get(module)?.size) {
      const list = Array.from(moduleToUsers.get(module)).slice(0, 3);
      sapUserAttribution = `Observado en ST03N: ${list.join(', ')}`;
    } else if (table && tableToUsers?.get(table)?.size) {
      const list = Array.from(tableToUsers.get(table)).slice(0, 3);
      sapUserAttribution = `Usuarios en tabla ${table}: ${list.join(', ')}`;
    }

    // Patrón de carga: Costo unitario vs Frecuencia
    let loadPattern = 'Mixto';
    if (avgElapsedMs >= 1000 && executions < 50000) {
      loadPattern = 'Alto costo por ejecución';
    } else if (executions >= 1000000 && avgElapsedMs < 50) {
      loadPattern = 'Frecuencia masiva de ejecución';
    } else if (avgElapsedMs >= 100) {
      loadPattern = 'Costo medio por ejecución';
    } else {
      loadPattern = 'Alta frecuencia';
    }

    let status = 'OK';
    if (elapsedSec >= 50000 || logicalReads >= 500000000 || physicalReads >= 50000000 || avgElapsedMs >= 10000) {
      status = 'CRITICAL';
    } else if (elapsedSec >= 10000 || logicalReads >= 100000000 || physicalReads >= 10000000 || appWaitMs >= 5000) {
      status = 'WARNING';
    }

    let whyAttention = 'Sentencia dentro de los mayores consumidores acumulados del Shared Cursor Cache.';
    if (sqlId === 'btm9skpdzjpgn') {
      whyAttention = 'CRÍTICO por costo unitario y E/S física: 20,6 s por ejecución y 600,9 millones de lecturas físicas sobre MSEG en código Z (SAPLZF_APP:5250), más 12,4 s de espera por bloqueo.';
    } else if (sqlId === '31fq4tdz5s7xr') {
      whyAttention = 'CRÍTICO por frecuencia extrema: 2.472 millones de ejecuciones sobre /QTQVC/CONTROL (polling Qlik), consumiendo 26.461 s (7,35 h) de CPU Oracle.';
    } else if (sqlId === '9qxkd8vp2satk') {
      whyAttention = 'CRÍTICO por volumen acumulado: 187 millones de ejecuciones sobre EKBE (42,7 h acumuladas y 1.020 millones de lecturas lógicas).';
    } else if (sqlId === 'afbrcznm7pjpx' || sqlId === 'b7cfwwp82na8j') {
      whyAttention = 'Alto impacto en FI (SAPL3008 sobre BKPF/partidas): supera 4.000 millones de lecturas lógicas o 104 millones de ejecuciones.';
    } else if (module.includes('EDOC') || module.includes('AIF')) {
      whyAttention = `Alto tiempo por ejecución (${avgElapsedMs.toLocaleString('es-CO')} ms/ejec) en proceso de Facturación Electrónica (${table || module}).`;
    }

    return {
      sqlId,
      sqlText,
      table: table || '—',
      module,
      action: action || '—',
      moduleAction,
      descriptionEs: PROGRAM_DESCRIPTIONS[module] || (table ? `Consulta SQL sobre tabla ${table}` : 'Sentencia SQL en caché Oracle'),
      dbUser,
      sapUserAttribution,
      executions,
      elapsedSec,
      avgElapsedMs,
      cpuSec,
      logicalReads,
      physicalReads,
      directWrites,
      rowsProcessed,
      appWaitMs,
      concWaitMs,
      ioWaitSec,
      memKb,
      lastActive: r.LAST_ACTIVE_TIME || '—',
      loadPattern,
      status,
      whyAttention
    };
  });
}

/**
 * Construye el panel de Actividad Actual en Tiempo Real (Panel D) cruzando MONITOR_SM_ORASESSION (V$SESSION + SM50).
 */
function buildActiveSessionsModel(oraSess) {
  const procList = Array.isArray(oraSess?.PROCESSLIST) ? oraSess.PROCESSLIST : [];
  const wpList = Array.isArray(oraSess?.WPTOTALINFO) ? oraSess.WPTOTALINFO : [];

  const wpByPid = new Map();
  wpList.forEach(wp => {
    const pid = String(wp.WP_PID || '').trim();
    if (pid) wpByPid.set(pid, wp);
  });

  // Filtrar sesiones de usuario Oracle (TYPE = 'US' o con USERNAME)
  const userSessions = procList
    .filter(p => String(p.USERNAME || '').trim() !== '' || p.TYPE === 'US')
    .map(p => {
      const clientPid = String(p.PROCESS || '').trim();
      const wp = wpByPid.get(clientPid);
      const event = String(p.EVENT || '').trim();
      const isIdleWait = event === 'SQL*Net message from client' || event === 'rdbms ipc message';
      const statusRaw = String(p.STATUS || '').trim();
      const secWait = Number(p.SECONDS_IN_WAIT || 0);
      const logicalReads = Number(p.LOGICAL_READS || 0);
      const physicalReads = Number(p.PHYS_READS || 0);
      const blockChanges = Number(p.BLOCK_CHG || 0);
      const pgaUsedMb = Number((Number(p.PGA_USED_MEM || 0) / (1024 * 1024)).toFixed(1));
      const pgaMaxMb = Number((Number(p.PGA_MAX_MEM || 0) / (1024 * 1024)).toFixed(1));

      const sapUser = wp && String(wp.WP_BNAME || '').trim() ? String(wp.WP_BNAME).trim() : null;
      const tcode = wp && String(wp.TCODE || '').trim() ? String(wp.TCODE).trim() : null;
      const report = wp && String(wp.WP_REPORT || '').trim() ? String(wp.WP_REPORT).trim() : null;
      const wpNo = wp ? Number(wp.WP_NO) : null;
      const wpType = wp ? String(wp.WP_TYP || '').trim() : null;
      const wpTable = wp && String(wp.WP_TABLE || '').trim() ? String(wp.WP_TABLE).trim() : null;
      const wpEltime = wp && String(wp.WP_ELTIME || '').trim() ? Number(wp.WP_ELTIME || 0) : 0;

      const isActiveSql = statusRaw === 'ACTIVE' && !isIdleWait;
      const isLockWait = event.toLowerCase().includes('enq:') || event.toLowerCase().includes('lock') || event.toLowerCase().includes('latch');

      let stateLabel = 'Inactiva (esperando petición de WP SAP)';
      let priority = 'OK';
      if (isLockWait) {
        stateLabel = `Bloqueo / contención activa (${event})`;
        priority = 'CRITICAL';
      } else if (isActiveSql && secWait >= 30) {
        stateLabel = `Consulta activa prolongada (${secWait}s en ${event})`;
        priority = 'WARNING';
      } else if (isActiveSql || (sapUser && report)) {
        stateLabel = `Ejecutando en vivo (${event})`;
      }

      return {
        sid: Number(p.SID || 0),
        spid: String(p.SPID || '').trim(),
        clientPid,
        dbUser: String(p.USERNAME || 'SAPSR3').trim(),
        sapUser: sapUser || 'Sin sesión activa en WP (conexión abierta en pool)',
        hasActiveSapContext: Boolean(sapUser || report || isActiveSql),
        wpNo,
        wpType: wpType || '—',
        tcode: tcode || '—',
        report: report || '—',
        wpTable: wpTable || '—',
        wpEltime,
        oracleStatus: statusRaw,
        isActiveSql,
        isLockWait,
        event,
        secondsInWait: secWait,
        logicalReads,
        physicalReads,
        blockChanges,
        pgaUsedMb,
        pgaMaxMb,
        sqlHash: String(p.SQL_HASH_VALUE || '0').trim(),
        sqlText: sanitizeSqlText(p.SQLTEXT) === 'No disponible' ? '' : sanitizeSqlText(p.SQLTEXT),
        stateLabel,
        priority
      };
    })
    .sort((a, b) => {
      if (a.isActiveSql !== b.isActiveSql) return a.isActiveSql ? -1 : 1;
      if (a.hasActiveSapContext !== b.hasActiveSapContext) return a.hasActiveSapContext ? -1 : 1;
      return b.logicalReads - a.logicalReads;
    });

  const activeNowCount = userSessions.filter(s => s.isActiveSql || s.hasActiveSapContext).length;
  const lockWaitCount = userSessions.filter(s => s.isLockWait).length;

  return {
    totalOracleSessions: procList.length,
    totalShadowConnections: userSessions.length,
    activeNowCount,
    lockWaitCount,
    sessions: userSessions.slice(0, 25)
  };
}

async function fetchDbacockpitFromSap(forceRefresh = false) {
  if (process.env.SAP_LIVE !== 'true') return null;

  const now = Date.now();
  if (!forceRefresh && cachedDbaData && (now - lastDbaFetchTs) < DBA_CACHE_TTL_MS) {
    return cachedDbaData;
  }

  try {
    // 1. Información del motor e instancia Oracle
    const [relRes, instRes] = await Promise.all([
      executeRfc('DB_ORA_GET_RELEASE', {}),
      executeRfc('DB_ORA_INSTANCE_INFO', {})
    ]);
    const inst = instRes?.LOCAL_DBINSTANCE || {};

    // 2. Sentencias SQL costosas desde V$SQLAREA (en bloques seguros <= 72 caracteres)
    const wclauses = [
      'ELAPSED_TIME > 500000000 AND ROWNUM <= 35',
      'BUFFER_GETS > 50000000 AND ROWNUM <= 35',
      'DISK_READS > 500000 AND ROWNUM <= 35',
      'EXECUTIONS > 1000000 AND ROWNUM <= 35'
    ];
    const rawSqlRows = [];
    for (const wc of wclauses) {
      try {
        const r = await executeRfc('STUO_GET_ORA_SYS_TABLE', { ORASYSTABN: 'V$SQLAREA', WCLAUSE: wc });
        rawSqlRows.push(...parseStuoTable(r));
      } catch (e) {
        console.warn('[DBACOCKPIT] Aviso en lectura parcial V$SQLAREA:', e.message);
      }
    }

    // 3. Carga de trabajo ST03N (SWNC) para Hoy y Ayer
    const todayDate = new Date();
    const yestDate = new Date(Date.now() - 86400000);
    const todayStr = formatYmd(todayDate);
    const yestStr = formatYmd(yestDate);

    let swncToday = await executeRfc('SWNC_COLLECTOR_GET_AGGREGATES', {
      COMPONENT: 'bonprd_BOP_00',
      PERIODTYPE: 'D',
      PERIODSTRT: todayStr
    }).catch(() => ({}));

    if (!swncToday?.USERTCODE?.length) {
      swncToday = await executeRfc('SWNC_COLLECTOR_GET_AGGREGATES', {
        COMPONENT: 'TOTAL',
        PERIODTYPE: 'D',
        PERIODSTRT: todayStr
      }).catch(() => ({}));
    }

    const swncYest = await executeRfc('SWNC_COLLECTOR_GET_AGGREGATES', {
      COMPONENT: 'TOTAL',
      PERIODTYPE: 'D',
      PERIODSTRT: yestStr
    }).catch(() => ({}));

    // 4. Sesiones Oracle activas en tiempo real (V$SESSION + SM50)
    const oraSess = await executeRfc('MONITOR_SM_ORASESSION', {}).catch(() => ({}));

    // Primero extraemos los mapas de usuarios/tablas para cruzarlos con V$SQLAREA
    const tempToday = buildWorkloadModels(swncToday, [], 'today', `Hoy (${formatSapDate(todayStr)})`);
    const tempYest = buildWorkloadModels(swncYest, [], 'yesterday', `Ayer (${formatSapDate(yestStr)})`);

    // Unir mapas de hoy y ayer para máxima trazabilidad de sentencias SQL
    const mergedModUsers = new Map(tempYest.moduleToUsers);
    tempToday.moduleToUsers.forEach((set, k) => {
      if (!mergedModUsers.has(k)) mergedModUsers.set(k, new Set());
      set.forEach(u => mergedModUsers.get(k).add(u));
    });
    const mergedTabUsers = new Map(tempYest.tableToUsers);
    tempToday.tableToUsers.forEach((set, k) => {
      if (!mergedTabUsers.has(k)) mergedTabUsers.set(k, new Set());
      set.forEach(u => mergedTabUsers.get(k).add(u));
    });

    const sqlStatements = buildSqlStatementsModel(rawSqlRows, mergedModUsers, mergedTabUsers);
    const todayModel = buildWorkloadModels(swncToday, sqlStatements, 'today', `Hoy (${formatSapDate(todayStr)})`);
    const yestModel = buildWorkloadModels(swncYest, sqlStatements, 'yesterday', `Ayer (${formatSapDate(yestStr)})`);
    const liveActivity = buildActiveSessionsModel(oraSess);

    // 5. Clasificación y priorización de hallazgos (Sección 4 y Resumen General)
    const findings = [
      {
        id: 'SQL_MSEG_Z',
        priority: 'CRITICAL',
        title: 'Sentencia SQL Z sobre MSEG con 600,9 millones de lecturas físicas y 20,6 s por ejecución',
        evidence: 'V$SQLAREA SQL_ID btm9skpdzjpgn · Módulo SAPLZF_APP (línea 5250) · 3.861 ejecuciones · 79.669 s acumulados · 684,9 M lecturas lógicas · 600,9 M lecturas físicas · 12,4 s espera por bloqueo · Invocado por Web Service ZWS_REPORTE_MOV_MERC (cuenta CONEXION).',
        impact: 'Genera el mayor volumen de lectura física de disco de toda la base de datos Oracle, degradando el subsistema de I/O cada vez que se invoca el servicio.',
        nextStep: 'Revisar en SE80/SE37 el grupo de funciones SAPLZF_APP (línea 5250) y en ST04 el plan de ejecución de btm9skpdzjpgn para restringir el escaneo de MSEG.'
      },
      {
        id: 'QLIK_POLLING_CPU',
        priority: 'CRITICAL',
        title: 'Usuario técnico QLIK y conector /QTQVC/ lideran el consumo de CPU y lecturas de BD',
        evidence: `ST03N Hoy: usuario QLIK acumula ${(todayModel.users.find(u => u.sapUser === 'QLIK')?.cpuTimeSec || 0).toLocaleString('es-CO')} s de CPU y ${(todayModel.users.find(u => u.sapUser === 'QLIK')?.dbTimeSec || 0).toLocaleString('es-CO')} s de tiempo BD (ayer: 95.104 s CPU y 39.491 s BD). En V$SQLAREA, SQL_ID 31fq4tdz5s7xr (/QTQVC/CONTROL) registra 2.472 millones de ejecuciones y 26.461 s de CPU Oracle.`,
        impact: 'Satura hilos de CPU y genera cientos de millones de lecturas físicas diarias por extracciones masivas y polling continuo.',
        nextStep: 'Auditar con el equipo de BI la frecuencia de polling de /QTQVC/SAPLCONNECTOR y programar las extracciones pesadas (/QTQVC/READ_DATA) fuera de horas pico.'
      },
      {
        id: 'EKBE_BKPF_FREQ',
        priority: 'WARNING',
        title: 'Consultas estándar sobre EKBE (SAPLME07) y BKPF (SAPL3008) con altísima frecuencia acumulada',
        evidence: 'SQL_ID 9qxkd8vp2satk (EKBE: 187 millones de ejecuciones, 42,7 h acumuladas) y SQL_ID afbrcznm7pjpx / b7cfwwp82na8j (SAPL3008 FI: > 4.016 millones de lecturas lógicas y 104,8 millones de ejecuciones).',
        impact: 'Aunque cada ejecución individual es rápida (< 6 ms), su repetición masiva dentro de bucles ABAP o reportes Z domina el tiempo total acumulado en el cursor cache.',
        nextStep: 'Activar brevemente SQL Monitor (transacción SQLM, actualmente inactivo) para identificar qué reportes Z o transacciones llaman en bucle a SAPLME07 y SAPL3008.'
      },
      {
        id: 'EDOCUMENT_LATENCY',
        priority: 'WARNING',
        title: 'Alta latencia de base de datos en jobs y clases de Facturación Electrónica (eDocument / AIF)',
        evidence: 'Usuario LQUINTERO acumula 79.316 s de tiempo BD ayer y 6.229 s hoy en RSBTONEJOB2 (SEND_EMAIL_EDOCUMENT_JOB). En V$SQLAREA destacan fxq1pyw1jwmp1 (EDOCUMENT, 9,0 s/ejec) y 2n492h70ad05m (UPDATE EDOAIFMSG, 22,1 s/ejec).',
        impact: 'Demoras en la transmisión y actualización de estados de documentos electrónicos y ocupación prolongada de procesos batch.',
        nextStep: 'Verificar estadísticas del optimizador Oracle e índices de las tablas EDOCUMENT, EDOAIFMSG y ZEDOAIFIDXREQ en DBACOCKPIT -> Space -> Single Table Analysis.'
      }
    ];

    const payload = {
      source: 'SAP_RFC_DBACOCKPIT_ORACLE_SWNC',
      fetchedAt: new Date().toISOString(),
      dbEngine: {
        type: 'ORACLE',
        version: `${inst.VERSION || '19.0.0.0.0'} (${relRes?.ORA_RELEASE || 'ORA1919'})`,
        dbName: inst.DB_NAME || 'BOP',
        instanceName: inst.DB_INSTANC || 'BOP',
        dbHost: inst.DB_SERVER || 'bonprd',
        dbSchemaUser: 'SAPSR3',
        startupFormatted: formatSapDate(inst.DB_UP_DATE, inst.DB_UP_TIME),
        archiverStatus: inst.ARCHIVER || 'STARTED',
        sqlmActive: false
      },
      summary: {
        overallStatus: 'CRITICAL',
        criticalCount: findings.filter(f => f.priority === 'CRITICAL').length,
        warningCount: findings.filter(f => f.priority === 'WARNING').length,
        activeProblemsNow: liveActivity.lockWaitCount,
        activeSessionsNow: liveActivity.activeNowCount,
        topUserToday: todayModel.users.sort((a, b) => b.dbTimeSec - a.dbTimeSec)[0]?.sapUser || 'QLIK',
        topProgramToday: todayModel.programs.sort((a, b) => b.dbTimeSec - a.dbTimeSec)[0]?.program || '/QTQVC/READ_DATA',
        topSqlId: 'btm9skpdzjpgn (MSEG · SAPLZF_APP)',
        mainRisk: 'Sobrecarga de I/O físico y CPU por extracciones continuas de QLIK (/QTQVC/READ_DATA) y consulta Z sobre MSEG (SAPLZF_APP, 600,9 M de lecturas físicas).',
        priorityAction: 'Optimizar consulta SQL btm9skpdzjpgn sobre MSEG en SAPLZF_APP:5250 y espaciar el polling de Qlik (/QTQVC/CONTROL).'
      },
      findings,
      periods: {
        today: {
          label: todayModel.periodLabel,
          totals: todayModel.totals,
          users: todayModel.users,
          programs: todayModel.programs,
          hourly: todayModel.hourly
        },
        yesterday: {
          label: yestModel.periodLabel,
          totals: yestModel.totals,
          users: yestModel.users,
          programs: yestModel.programs,
          hourly: yestModel.hourly
        }
      },
      sqlStatements,
      liveActivity,
      technicalLimitations: [
        'Motor identificado: Oracle Database 19c (19.0.0.0.0 / ORA1919) en servidor bonprd (instancia BOP).',
        'Conexión de esquema único: Todos los Work Processes ABAP se conectan a Oracle bajo el mismo usuario de base de datos (SAPSR3). Por ello, V$SQLAREA conoce el programa ABAP (MODULE) y la línea (ACTION), pero no almacena el usuario final SAP (SY-UNAME).',
        'Cruce de atribución aplicado: Los paneles A y B obtienen la atribución exacta por usuario SAP y transacción desde el recolector de carga ST03N (SWNC_COLLECTOR_GET_AGGREGATES: USERTCODE y HITLIST_DATABASE), y se cruzan por nombre de programa/tabla con V$SQLAREA.',
        'Cuentas técnicas compartidas: Las cuentas QLIK y CONEXION agrupan llamadas de conectores externos y Web Services; no representan a una persona individual.',
        'ABAP SQL Monitor (transacción SQLM): Actualmente inactivo en BOP (SQLM_API_IS_SQLM_ACTIVE = falso). Si se requiere cruzar cada SQL_ID exacto con la transacción y el usuario final que lo disparó sin usar trazas ST05 puntuales, un administrador Basis puede activar SQLM temporalmente.'
      ]
    };

    cachedDbaData = payload;
    lastDbaFetchTs = now;
    return payload;
  } catch (err) {
    console.error('[DBACOCKPIT SERVICE] Error consultando métricas de base de datos:', err.message);
    return cachedDbaData || null;
  }
}

async function getDbacockpitMetrics(forceRefresh = false) {
  const live = await fetchDbacockpitFromSap(forceRefresh);
  return live || {
    source: 'FALLBACK_OFFLINE',
    fetchedAt: new Date().toISOString(),
    dbEngine: { type: 'ORACLE', version: '19.0.0.0.0 (ORA1919)', dbName: 'BOP', instanceName: 'BOP', dbHost: 'bonprd', dbSchemaUser: 'SAPSR3', startupFormatted: '06.10.2025 22:39:47', archiverStatus: 'STARTED', sqlmActive: false },
    summary: { overallStatus: 'WARNING', criticalCount: 0, warningCount: 1, activeProblemsNow: 0, activeSessionsNow: 0, topUserToday: 'No disponible', topProgramToday: 'No disponible', topSqlId: 'No disponible', mainRisk: 'Sin conexión en vivo a SAP.', priorityAction: 'Verificar conectividad RFC.' },
    findings: [],
    periods: { today: { label: 'Hoy', totals: {}, users: [], programs: [], hourly: [] }, yesterday: { label: 'Ayer', totals: {}, users: [], programs: [], hourly: [] } },
    sqlStatements: [],
    liveActivity: { totalOracleSessions: 0, totalShadowConnections: 0, activeNowCount: 0, lockWaitCount: 0, sessions: [] },
    technicalLimitations: ['Modo sin conexión a SAP.']
  };
}

module.exports = {
  getDbacockpitMetrics
};
