const { SAP_CONFIG, rfcClient, executeRfc, rfcInitError } = require('../config/sap');

// Datos de respaldo por si SAP devuelve error o SAP_LIVE=false
function getFallbackData(customBanner) {
  return {
    mode: customBanner || 'SIMULACIÓN ACTIVA (Configura SAP_LIVE=true en .env para producción)',
    environment: process.env.ENVIRONMENT_NAME || 'CALIDAD (QAS)',
    sysid: 'BOQ',
    client: SAP_CONFIG.client || '300',
    license_limit: 334,
    active_users: 331,
    locked_admin: 28,
    locked_failed: 5,
    expired_users: 14,
    dumps_today: 2,
    ws_errors_count: 3,
    resets_today: 0,
    resets_month: 4,
    hr_job: {
      jobname: 'ZHR_BLOQUEO_RETIROS_DIARIO',
      status: 'F',
      strtdate: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
      strttime: '060002',
      enddate: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
      endtime: '060018',
      blocked_today: 3
    },
    inactive_30d: [
      { bname: 'JPURNS01', class: 'COMPRAS', trdat: '2026-08-29', days_inactive: 49 },
      { bname: 'MRODRIGUEZ', class: 'CONTABILIDAD', trdat: '2026-09-04', days_inactive: 43 },
      { bname: 'LCASTRO_EXT', class: 'LOGISTICA', trdat: '2026-09-11', days_inactive: 36 },
      { bname: 'ACORTEZ', class: 'CALIDAD', trdat: '2026-09-14', days_inactive: 33 }
    ],
    work_processes: [
      { wp_no: 0, wp_typ: 'DIA', wp_status: 'Running', wp_bname: 'ACARVAJAL', wp_report: 'SAPLSLVC_FULLSCREEN', wp_action: 'Sequential Read BSEG', wp_eltime: 415, wp_table: 'BSEG' },
      { wp_no: 1, wp_typ: 'DIA', wp_status: 'Running', wp_bname: 'MGOMEZ', wp_report: 'SAPMF05A (FB01)', wp_action: 'Commit Work', wp_eltime: 4, wp_table: 'BKPF' },
      { wp_no: 2, wp_typ: 'DIA', wp_status: 'Waiting', wp_bname: '', wp_report: '', wp_action: '', wp_eltime: 0, wp_table: '' },
      { wp_no: 3, wp_typ: 'DIA', wp_status: 'Waiting', wp_bname: '', wp_report: '', wp_action: '', wp_eltime: 0, wp_table: '' },
      { wp_no: 4, wp_typ: 'BTC', wp_status: 'Running', wp_bname: 'SAPSYS', wp_report: 'RSCONN01', wp_action: 'Send Mail / SOST', wp_eltime: 12, wp_table: 'SOOD' },
      { wp_no: 5, wp_typ: 'BTC', wp_status: 'Running', wp_bname: 'BATCH_ADM', wp_report: 'ZFI_CARTERA_NOTIF', wp_action: 'Select KNA1', wp_eltime: 88, wp_table: 'BSID' }
    ],
    user_sessions: [
      { bname: 'ACARVAJAL', tcode: 'FBL1N', term: '192.168.10.45', zeit: '19:42:10', mandt: '300' },
      { bname: 'MGOMEZ', tcode: 'FB60', term: '192.168.10.88', zeit: '19:55:02', mandt: '300' },
      { bname: 'JPEREZ', tcode: 'CO11N', term: '192.168.22.14', zeit: '19:56:40', mandt: '300' },
      { bname: 'KLOPEZ', tcode: 'QA32', term: '192.168.22.19', zeit: '19:57:11', mandt: '300' }
    ],
    sm12_locks: [
      { guname: 'JPEREZ', gname: 'AUFK', garg: '3000001049821', gmode: 'E (Exclusivo)', duration_min: 24, tcode: 'CO02' },
      { guname: 'MGOMEZ', gname: 'BKPF', garg: '300DA1720006753092026', gmode: 'E (Exclusivo)', duration_min: 2, tcode: 'FB60' }
    ],
    ws_cpi_errors: [
      { timestamp: '19:41:12', if_name: 'SI_Out_FacturacionElectronica_CPI', err_type: 'HTTP 502 Bad Gateway', uname: 'PI_APPL_USER', error_text: 'ICM_HTTP_CONNECTION_BROKEN hacia endpoint CPI' },
      { timestamp: '17:15:04', if_name: 'ZWs_ConsultaCupoCredito_REST', err_type: 'SOAP_RUNTIME_TIMEOUT', uname: 'RFC_PORTAL', error_text: 'Tiempo de espera agotado (30000ms) en nodo destino' },
      { timestamp: '14:02:51', if_name: 'SI_In_RecuadoBancos_CPI', err_type: 'CX_ST_MATCH_ELEMENT', uname: 'CPI_INTEGRATION', error_text: 'Error de estructura XML en nodo Moneda/TasaCambio' }
    ],
    st22_dumps: [
      { time: '18:12:30', errid: 'TIME_OUT', uname: 'ACARVAJAL', program: 'SAPLSLVC_FULLSCREEN', info: 'Tiempo límite de diálogo superado (600s)' },
      { time: '11:04:15', errid: 'CONVT_NO_NUMBER', uname: 'LCASTRO_EXT', program: 'ZMM_INGRESO_BASCULA', info: 'No se puede interpretar "12,5A" como número' }
    ]
  };
}

// Normaliza y decodifica errores de Web Services y Endpoints CPI (SRT_UTIL / SMICM).
// SAP almacena el contexto de error en formato XML codificado en Base64 en la tabla SRT_UTIL_ERRLOG.
// Esta función decodifica el Base64, extrae los parámetros legibles (interfaz, operación, endpoint,
// puerto lógico, código de error HTTP / SOAP) y genera un mensaje limpio y comprensible.
function parseWsError(err) {
  if (!err || typeof err !== 'object') return err;

  let text = String(err.error_text || '').trim();
  let decodedXml = '';

  // 1. Detectar y decodificar Base64 si aplica
  if (/^[A-Za-z0-9+/=]+$/.test(text) && text.length % 4 === 0 && text.length > 20) {
    try {
      const decoded = Buffer.from(text, 'base64').toString('utf8');
      if (decoded.includes('<') && decoded.includes('>')) {
        decodedXml = decoded;
      }
    } catch (_) {}
  } else if (text.includes('<') && text.includes('>')) {
    decodedXml = text;
  }

  const getTag = (xml, tag) => {
    const m = xml.match(new RegExp('<' + tag + '>(.*?)</' + tag + '>', 'i'));
    return m ? m[1].trim() : '';
  };

  let ifName = err.if_name && err.if_name !== 'N/A' ? err.if_name : '';
  let errType = err.err_type && err.err_type !== 'WS_ERROR' ? err.err_type : 'WS_ERROR';
  let cleanMessage = text;
  let targetEndpoint = '';
  let logicalPort = '';
  let operation = '';

  if (decodedXml) {
    const xmlIfName = getTag(decodedXml, 'INTERFACE_NAME');
    const proxyName = getTag(decodedXml, 'CONSUMER_PROXY');
    const opName = getTag(decodedXml, 'OPERATION_NAME');
    logicalPort = getTag(decodedXml, 'LOGICAL_PORT');
    operation = opName;

    if (!ifName || ifName === 'N/A') {
      ifName = xmlIfName || proxyName || 'Web Service';
      if (opName && opName !== ifName) {
        ifName += ` (${opName})`;
      }
    }

    const httpErr = getTag(decodedXml, 'HTTP_ERROR_TEXT');
    const htmlPage = getTag(decodedXml, 'HTML_ERROR_PAGE');
    const faultStr = getTag(decodedXml, 'faultstring') || getTag(decodedXml, 'EXCEPTION_TEXT') || getTag(decodedXml, 'MESSAGE');
    const faultCode = getTag(decodedXml, 'faultcode');
    const host = getTag(decodedXml, 'TARGET_HOST_NAME');
    const path = getTag(decodedXml, 'TARGET_PATH');
    const proto = getTag(decodedXml, 'PROTOCOL') || 'https';
    const port = getTag(decodedXml, 'TARGET_PORT_NUMBER');

    if (host) {
      targetEndpoint = `${proto}://${host}${port && port !== '443' && port !== '80' ? ':' + port : ''}${path}`;
    }

    if (httpErr) {
      if (httpErr.toLowerCase().includes('not found')) {
        errType = 'HTTP 404 (Not Found)';
      } else if (httpErr.toLowerCase().includes('unauthorized')) {
        errType = 'HTTP 401 (Unauthorized)';
      } else if (httpErr.toLowerCase().includes('forbidden')) {
        errType = 'HTTP 403 (Forbidden)';
      } else if (httpErr.toLowerCase().includes('gateway') || httpErr.toLowerCase().includes('bad gateway')) {
        errType = 'HTTP 502 (Bad Gateway)';
      } else if (httpErr.toLowerCase().includes('timeout') || httpErr.toLowerCase().includes('gateway timeout')) {
        errType = 'HTTP 504 (Timeout)';
      } else {
        errType = `HTTP: ${httpErr}`;
      }

      cleanMessage = `Fallo en llamada Web Service: ${httpErr}`;
      if (htmlPage && htmlPage !== httpErr) {
        cleanMessage += ` — ${htmlPage}`;
      }
      if (targetEndpoint) {
        cleanMessage += ` hacia ${targetEndpoint}`;
      }
      if (logicalPort) {
        cleanMessage += ` [Puerto Lógico: ${logicalPort}]`;
      }
    } else if (faultStr) {
      errType = faultCode ? `SOAP: ${faultCode}` : 'SOAP Fault';
      cleanMessage = `Fallo SOAP: ${faultStr}`;
      if (targetEndpoint) {
        cleanMessage += ` en ${targetEndpoint}`;
      }
      if (logicalPort) {
        cleanMessage += ` [Puerto Lógico: ${logicalPort}]`;
      }
    } else {
      const stripped = decodedXml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      cleanMessage = stripped.slice(0, 300) + (stripped.length > 300 ? '...' : '');
    }
  }

  // 2. Formatear timestamp si viene en formato numérico o string YYYYMMDDHHmmss
  let timeFormatted = String(err.timestamp || '');
  const tsStr = String(err.timestamp || '').trim();
  if (/^\d{14}$/.test(tsStr)) {
    const hh = tsStr.slice(8, 10);
    const mm = tsStr.slice(10, 12);
    const ss = tsStr.slice(12, 14);
    timeFormatted = `${hh}:${mm}:${ss}`;
  }

  return {
    ...err,
    if_name: ifName || 'Web Service',
    err_type: errType,
    error_text: cleanMessage,
    target_endpoint: targetEndpoint,
    logical_port: logicalPort,
    operation: operation,
    timestamp: timeFormatted,
    raw_error_text: text,
    raw_decoded: decodedXml
  };
}

function normalizeWsErrors(errors) {
  if (!Array.isArray(errors)) return [];
  return errors.map(parseWsError);
}

// Obtener métricas del Dashboard desde SAP (Z_ERP_DASHBOARD_METRICS)
async function fetchSapDashboardData() {
  if (process.env.SAP_LIVE === 'true') {
    if (!rfcClient) {
      return getFallbackData(`ERROR LOCAL: node-rfc no disponible (${rfcInitError}) - Mostrando Simulación`);
    }
    try {
      const res = await executeRfc('Z_ERP_DASHBOARD_METRICS', {});
      const parsed = JSON.parse(res.EV_JSON_RESPONSE);
      return {
        mode: `CONECTADO EN VIVO A SAP ${parsed.environment || ''} (${parsed.sysid || 'BOQ'} - Mandante ${parsed.client || SAP_CONFIG.client})`,
        ...parsed,
        ws_cpi_errors: normalizeWsErrors(parsed.ws_cpi_errors)
      };
    } catch (sapErr) {
      console.error('[ERROR CONEXIÓN SAP RFC]:', sapErr.message || sapErr);
      return getFallbackData(`ERROR SAP RFC: ${sapErr.message || 'Fallo de conexión'} (Mostrando datos de respaldo)`);
    }
  }

  return getFallbackData();
}

// Bloquear o desbloquear usuario en SAP (BAPI_USER_CHANGE, BAPI_USER_LOCK, BAPI_USER_UNLOCK)
async function manageUserLock(bname, action, lastDate) {
  if (rfcClient && process.env.SAP_LIVE === 'true') {
    await rfcClient.open();

    if (action === 'LOCK') {
      // 1. Limpiar y validar la fecha límite.
      // Si viene nula, con ceros o vacía, usamos la fecha de hoy.
      let validToDate = lastDate ? lastDate.replace(/\D/g, '') : '';
      if (!validToDate || validToDate === '00000000') {
        const today = new Date();
        const yyyy = today.getFullYear();
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const dd = String(today.getDate()).padStart(2, '0');
        validToDate = `${yyyy}${mm}${dd}`;
      }

      // 2. Modificar la fecha de "Fin de Validez" (GLTGB) en la pestaña Datos Logon
      try {
        await rfcClient.call('BAPI_USER_CHANGE', {
          USERNAME: bname,
          LOGONDATA: { GLTGB: validToDate },
          LOGONDATAX: { GLTGB: 'X' }
        });
      } catch (changeErr) {
        console.error(`[ERROR BAPI_USER_CHANGE] No se pudo cambiar la fecha para ${bname}:`, changeErr);
        // Continuamos para al menos intentar bloquearlo aunque la fecha falle
      }

      // 3. Aplicar el candado de bloqueo
      await rfcClient.call('BAPI_USER_LOCK', { USERNAME: bname });
    } else {
      // Desbloquear usuario
      await rfcClient.call('BAPI_USER_UNLOCK', { USERNAME: bname });
    }

    await rfcClient.close();
  }

  return {
    success: true,
    message: `Usuario ${bname} ${action === 'LOCK' ? 'bloqueado y vigencia expirada al ' + (lastDate || 'hoy') : 'desbloqueado exitosamente'}.`
  };
}

// Cancelar Work Process en SAP (Z_CANCEL_WORK_PROCESS)
async function cancelWorkProcess(wp_no) {
  if (rfcClient && process.env.SAP_LIVE === 'true') {
    await rfcClient.open();

    const result = await rfcClient.call('Z_CANCEL_WORK_PROCESS', {
      IV_WP_NO: parseInt(wp_no, 10)
    });

    await rfcClient.close();

    return {
      success: result.EV_SUCCESS === 'X',
      message: result.EV_MESSAGE
    };
  }

  // Modo simulación
  return {
    success: true,
    message: `(Simulación) Work Process ${wp_no} cancelado.`
  };
}

const HEAVY_TABLES = [
  'BSEG', 'BKPF', 'MSEG', 'ACDOCA', 'COEP', 'VBAP', 'VBAK',
  'BSID', 'BSAD', 'BSIK', 'BSAK', 'EKPO', 'EKKO', 'MARA', 'MARC',
  'PA0001', 'PA0002', 'PA0015', 'GLPCA', 'EDIDC', 'EDID4'
];

function isWpActive(wp) {
  const status = String(wp.wp_status || '').toLowerCase().trim();
  if (status === 'espera' || status === 'waiting') {
    return Boolean(wp.wp_bname && wp.wp_bname !== '-' && wp.wp_bname.trim() !== '');
  }
  return true;
}

/**
 * Diagnóstico y Análisis Operativo de Procesos en Tiempo Real (SM50 / SM66)
 */
function analyzeWorkProcesses(workProcesses = [], userSessions = []) {
  let diaBusy = 0, diaTotal = 0;
  let btcBusy = 0, btcTotal = 0;
  let slowProcessesCount = 0;

  const anomalies = [];
  const userProcessCount = {};
  const reportProcessCount = {};

  (workProcesses || []).forEach(wp => {
    const isActive = isWpActive(wp);
    const typ = (wp.wp_typ || '').toUpperCase();
    const eltime = parseInt(String(wp.wp_eltime || '').trim(), 10) || 0;
    const action = String(wp.wp_action || '').toLowerCase().trim();
    const table = String(wp.wp_table || '').toUpperCase().trim();
    const user = String(wp.wp_bname || '').trim();
    const report = String(wp.wp_report || '').trim();
    const status = String(wp.wp_status || '').toLowerCase().trim();

    if (typ === 'DIA') {
      diaTotal++;
      if (isActive) diaBusy++;
    } else if (typ === 'BTC') {
      btcTotal++;
      if (isActive) btcBusy++;
    }

    if (isActive) {
      if (eltime > 300 && typ === 'DIA') {
        slowProcessesCount++;
      }

      // Conteo por usuario
      if (user && user !== '-') {
        if (!userProcessCount[user]) userProcessCount[user] = [];
        userProcessCount[user].push({ wp_no: wp.wp_no, typ, report, eltime });
      }

      // Conteo por reporte
      if (report && report !== '-') {
        if (!reportProcessCount[report]) reportProcessCount[report] = [];
        reportProcessCount[report].push({ wp_no: wp.wp_no, typ, user, eltime });
      }

      // 1. Anomalía: Tiempo de ejecución crítico en diálogo (> 300 segundos)
      if (typ === 'DIA' && eltime > 300) {
        anomalies.push({
          id: `timeout-wp-${wp.wp_no}`,
          type: 'TIMEOUT_RISK',
          severity: eltime > 500 ? 'critical' : 'high',
          badge: 'Riesgo de TIME_OUT',
          badgeColor: 'rose',
          wp_no: wp.wp_no,
          wp_typ: typ,
          wp_bname: user || 'Desconocido',
          wp_report: report || 'Sin reporte',
          wp_action: wp.wp_action || 'En ejecución',
          wp_table: table,
          wp_eltime: eltime,
          reason: `El proceso de diálogo lleva ${eltime}s en ejecución. Al superar el umbral de 300s se encuentra cerca del límite definido en rdisp/max_wprun_time y generará un Short Dump en ST22.`,
          recommendation: `Cancelar puntualmente el Work Process #${wp.wp_no} para liberar el recurso de diálogo sin reiniciar la instancia.`
        });
      }

      // 2. Anomalía: Lectura secuencial pesada sobre tablas críticas
      const isSequential = action.includes('read') || action.includes('lectura') || action.includes('seq') || action.includes('secuencial') || action.includes('select');
      const isCriticalTable = HEAVY_TABLES.includes(table);
      if (isSequential && (isCriticalTable || eltime > 60)) {
        anomalies.push({
          id: `seqread-wp-${wp.wp_no}`,
          type: 'HEAVY_SEQUENTIAL_READ',
          severity: eltime > 180 ? 'high' : 'medium',
          badge: isCriticalTable ? `Lectura Secuencial [${table}]` : 'Lectura Secuencial Pesada',
          badgeColor: 'amber',
          wp_no: wp.wp_no,
          wp_typ: typ,
          wp_bname: user || 'Desconocido',
          wp_report: report || 'Sin reporte',
          wp_action: wp.wp_action || 'Sequential Read',
          wp_table: table,
          wp_eltime: eltime,
          reason: `Lectura secuencial masiva sobre la tabla ${table || 'de base de datos'}. Este tipo de operación barre bloques enteros de disco provocando contención de I/O y bloqueo de memoria caché.`,
          recommendation: `Verificar filtros en la transacción ${report} (ej. campos clave de fecha, sociedad, centro) o evaluar la creación de índices secundarios en SE11.`
        });
      }

      // 3. Anomalía: Proceso en espera de bloqueo (Lock / Enqueue)
      const isLockWait = action.includes('lock') || action.includes('bloq') || action.includes('enqueue') || status.includes('lock') || status.includes('bloq');
      if (isLockWait) {
        anomalies.push({
          id: `lock-wp-${wp.wp_no}`,
          type: 'LOCK_WAIT',
          severity: 'high',
          badge: 'Espera de Bloqueo',
          badgeColor: 'purple',
          wp_no: wp.wp_no,
          wp_typ: typ,
          wp_bname: user || 'Desconocido',
          wp_report: report || 'Sin reporte',
          wp_action: wp.wp_action || 'Waiting for lock',
          wp_table: table,
          wp_eltime: eltime,
          reason: `El proceso está detenido esperando la liberación de un bloqueo encolado (SM12). Puede causar efecto dominó reteniendo hilos subsiguientes.`,
          recommendation: `Inspeccionar la transacción SM12 para identificar el usuario o transacción que retiene el lock exclusivo y proceder a su liberación.`
        });
      }
    }
  });

  // 4. Anomalía: Concentración anómala por usuario (>= 2 procesos activos)
  Object.keys(userProcessCount).forEach(u => {
    const list = userProcessCount[u];
    if (list.length >= 2) {
      anomalies.push({
        id: `concentration-user-${u}`,
        type: 'USER_CONCENTRATION',
        severity: list.length >= 3 ? 'high' : 'medium',
        badge: 'Concentración de Procesos',
        badgeColor: 'cyan',
        wp_no: list.map(p => `#${p.wp_no}`).join(', '),
        wp_typ: list.map(p => p.typ).join('/'),
        wp_bname: u,
        wp_report: list.map(p => p.report).filter(Boolean).join(', ') || 'Varios',
        wp_action: 'Múltiples hilos activos en paralelo',
        wp_table: '',
        wp_eltime: Math.max(...list.map(p => p.eltime)),
        reason: `El usuario ${u} mantiene ${list.length} hilos de procesamiento ocupados en paralelo, reduciendo el margen disponible para el resto de usuarios.`,
        recommendation: `Consultar en AL08 si el usuario tiene sesiones duplicadas abiertas o si está ejecutando tareas asíncronas no controladas.`
      });
    }
  });

  const diaBusyPct = diaTotal > 0 ? parseFloat(((diaBusy / diaTotal) * 100).toFixed(1)) : 0;
  const btcBusyPct = btcTotal > 0 ? parseFloat(((btcBusy / btcTotal) * 100).toFixed(1)) : 0;

  // Evaluación de Saturación Global
  let status = 'HEALTHY';
  let color = 'emerald';
  let title = 'Operación Estable';
  let description = `El Application Server opera con holgura. Disponibilidad del ${parseFloat((100 - diaBusyPct).toFixed(1))}% en procesos de diálogo.`;
  let dispatcherCapacity = 'Óptima: Atendiendo peticiones sin cola en Dispatcher.';

  if (diaBusyPct >= 80 || (diaTotal > 0 && diaBusy === diaTotal)) {
    status = 'CRITICAL';
    color = 'rose';
    title = 'Saturación Crítica en Diálogo';
    description = `Saturación del ${diaBusyPct}% en procesos DIA (${diaBusy}/${diaTotal}). El Dispatcher no dispone de hilos libres para nuevas transacciones de usuarios.`;
    dispatcherCapacity = 'En riesgo / Bloqueado: Los usuarios nuevos o transacciones entrantes sufrirán esperas en la cola de dispatcher.';
  } else if (diaBusyPct >= 50 || slowProcessesCount > 0 || anomalies.length > 0) {
    status = 'WARNING';
    color = 'amber';
    title = 'Alerta de Carga / Cuellos de Botella';
    description = `Carga moderada a alta (${diaBusyPct}% DIA ocupados). Se han identificado ${anomalies.length} anomalía(s) en ejecución.`;
    dispatcherCapacity = 'Moderada: El Dispatcher responde pero existen demoras en transacciones específicas.';
  }

  // Generación del Plan de Acción
  const actionPlan = {
    immediate: [],
    preventive: [],
    basis_parameters: []
  };

  // Inmediatas
  const timeoutAnomalies = anomalies.filter(a => a.type === 'TIMEOUT_RISK');
  if (timeoutAnomalies.length > 0) {
    timeoutAnomalies.forEach(a => {
      actionPlan.immediate.push({
        priority: 'ALTA',
        action: `Cancelar selectivamente el Work Process #${a.wp_no} (Usuario: ${a.wp_bname}, Programa: ${a.wp_report}) antes de que se produzca un short dump TIME_OUT.`,
        target_wp: a.wp_no,
        user: a.wp_bname
      });
    });
  }

  const lockAnomalies = anomalies.filter(a => a.type === 'LOCK_WAIT');
  if (lockAnomalies.length > 0) {
    actionPlan.immediate.push({
      priority: 'ALTA',
      action: 'Revisar la transacción SM12 de inmediato para liberar los bloqueos exclusivos que mantienen hilos retenidos.',
      target_wp: lockAnomalies[0].wp_no,
      user: lockAnomalies[0].wp_bname
    });
  }

  if (diaBusyPct >= 80) {
    actionPlan.immediate.push({
      priority: 'URGENTE',
      action: 'Notificar al equipo de operaciones sobre saturación del Dispatcher. Solicitar suspender lanzamientos masivos de transacciones interactivas.',
      target_wp: null,
      user: 'TODOS'
    });
  }

  if (actionPlan.immediate.length === 0) {
    actionPlan.immediate.push({
      priority: 'INFO',
      action: 'No se requieren cancelaciones forzadas. La asignación de hilos DIA/BTC se encuentra dentro de parámetros normales.',
      target_wp: null,
      user: null
    });
  }

  // Preventivas
  const seqAnomalies = anomalies.filter(a => a.type === 'HEAVY_SEQUENTIAL_READ');
  if (seqAnomalies.length > 0) {
    const tablesList = [...new Set(seqAnomalies.map(a => a.wp_table).filter(Boolean))].join(', ');
    actionPlan.preventive.push(
      `Optimizar variantes de ejecución en reportes que lean ${tablesList || 'tablas masivas'}, asegurando obligatoriedad de filtros por fechas e índices primarios.`
    );
    actionPlan.preventive.push(
      `Revisar en transacciones DB02 / ST04 los accesos a disco e índices secundarios faltantes para ${tablesList || 'las tablas involucradas'}.`
    );
  } else {
    actionPlan.preventive.push(
      'Monitorear periódicamente los reportes ALV en horarios pico para prevenir barridos secuenciales sin filtros.'
    );
  }

  if (btcBusyPct >= 70) {
    actionPlan.preventive.push(
      'Reprogramar jobs batch en segundo plano (SM36/SM37) fuera del horario laboral o en ventanas nocturnas para desocupar hilos del servidor.'
    );
  } else {
    actionPlan.preventive.push(
      'Mantener los procesos de extracción analítica y jobs pesados planificados en ventanas no pico.'
    );
  }

  // Parámetros de Sistema Basis
  actionPlan.basis_parameters.push({
    param: 'rdisp/max_wprun_time',
    current_context: 'Límite de tiempo máximo para hilos de Diálogo (segundos)',
    recommendation: 'Revisar en RZ11. El valor estándar oscila entre 300 y 600 segundos para evitar que transacciones interactivas monopolicen hilos del Dispatcher.'
  });

  if (diaBusyPct >= 75) {
    actionPlan.basis_parameters.push({
      param: 'rdisp/wp_no_dia',
      current_context: `Procesos DIA configurados actualmente: ${diaTotal}`,
      recommendation: 'Si la saturación supera el 80% continuamente con memoria RAM suficiente, evaluar en RZ10 incrementar la cantidad de procesos DIA en el perfil de instancia.'
    });
  }

  actionPlan.basis_parameters.push({
    param: 'rdisp/wp_no_btc',
    current_context: `Procesos BTC configurados actualmente: ${btcTotal}`,
    recommendation: 'Verificar la relación DIA vs BTC según la carga operativa predominante (transaccional en el día, procesamiento masivo en la noche).'
  });

  return {
    timestamp: new Date().toISOString(),
    local_time: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    saturation: {
      status,
      color,
      title,
      description,
      dia: {
        busy: diaBusy,
        total: diaTotal,
        pct: diaBusyPct
      },
      btc: {
        busy: btcBusy,
        total: btcTotal,
        pct: btcBusyPct
      },
      active_total: diaBusy + btcBusy,
      total_processes: (workProcesses || []).length,
      slow_processes: slowProcessesCount,
      dispatcher_capacity: dispatcherCapacity
    },
    anomalies,
    action_plan: actionPlan
  };
}

module.exports = {
  getFallbackData,
  fetchSapDashboardData,
  manageUserLock,
  cancelWorkProcess,
  analyzeWorkProcesses
};

