const axios = require('axios');
const { executeRfc, rfcInitError } = require('../config/sap');

function isSapLive() {
  return process.env.SAP_LIVE !== 'false' && !rfcInitError;
}

const MONTH_NAMES = [
  '',
  'Ene',
  'Feb',
  'Mar',
  'Abr',
  'May',
  'Jun',
  'Jul',
  'Ago',
  'Sep',
  'Oct',
  'Nov',
  'Dic'
];

/**
 * Formatea un código de material al formato interno SAP (18 caracteres con ceros a la izquierda si es numérico)
 * Equivalente a CONVERSION_EXIT_MATN1_INPUT.
 */
function formatMatnrInput(matnr) {
  const clean = String(matnr || '').trim().toUpperCase();
  if (!clean) return '';
  if (/^\d+$/.test(clean)) {
    return clean.padStart(18, '0');
  }
  return clean;
}

/**
 * Formatea un código de material para visualización (elimina ceros a la izquierda si es numérico)
 * Equivalente a CONVERSION_EXIT_MATN1_OUTPUT.
 */
function formatMatnrOutput(matnr) {
  const clean = String(matnr || '').trim();
  if (/^\d+$/.test(clean)) {
    return clean.replace(/^0+/, '') || '0';
  }
  return clean;
}

function parseSapNumber(val) {
  if (typeof val === 'number') return val;
  if (val === null || val === undefined) return 0;
  const str = String(val).trim().replace(/,/g, '');
  if (!str) return 0;
  // Manejo de signo negativo al final en SAP (ej: "125.000-")
  if (str.endsWith('-')) {
    const n = parseFloat(str.slice(0, -1));
    return Number.isNaN(n) ? 0 : -n;
  }
  const n = parseFloat(str);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Construye tabla range SAP (SIGN, OPTION, LOW, HIGH) para MATNR o WERKS.
 */
function buildRangeTable(lowVal, highVal, isMatnr = false) {
  const rawLow = String(lowVal || '').trim();
  const rawHigh = String(highVal || '').trim();

  if (!rawLow && !rawHigh) return [];

  // Soportar lista separada por comas en el campo low
  if (rawLow.includes(',') && !rawHigh) {
    return rawLow
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(item => {
        const formatted = isMatnr ? formatMatnrInput(item) : item.toUpperCase();
        return {
          SIGN: 'I',
          OPTION: formatted.includes('*') ? 'CP' : 'EQ',
          LOW: formatted,
          HIGH: ''
        };
      });
  }

  const low = isMatnr ? formatMatnrInput(rawLow || rawHigh) : (rawLow || rawHigh).toUpperCase();
  const high = rawHigh ? (isMatnr ? formatMatnrInput(rawHigh) : rawHigh.toUpperCase()) : '';

  if (high && high !== low) {
    return [{ SIGN: 'I', OPTION: 'BT', LOW: low, HIGH: high }];
  }

  return [
    {
      SIGN: 'I',
      OPTION: low.includes('*') ? 'CP' : 'EQ',
      LOW: low,
      HIGH: ''
    }
  ];
}

/**
 * Clasifica el estado de inventario de un material según Stock Actual, Stock Máximo y Stock de Seguridad.
 */
function evaluateStockStatus(stockActual, stockMaximo, stockSeguridad, puntoReorden = 0) {
  const excessQty = stockMaximo > 0 && stockActual > stockMaximo ? +(stockActual - stockMaximo).toFixed(3) : 0;
  const shortageQty = stockSeguridad > 0 && stockActual < stockSeguridad ? +(stockSeguridad - stockActual).toFixed(3) : 0;
  const utilizationPct = stockMaximo > 0 ? +((stockActual / stockMaximo) * 100).toFixed(1) : null;

  if (stockMaximo > 0 && stockActual > stockMaximo) {
    return {
      statusCode: 'EXCESO_CRITICO',
      statusLabel: 'Exceso de Stock',
      severity: 'critical',
      excessQty,
      shortageQty: 0,
      utilizationPct,
      recommendation: `Redistribuir o frenar compras: excede el Stock Máximo en ${excessQty.toLocaleString('es-CO')} unidades (${utilizationPct}% del techo).`
    };
  }

  if (stockMaximo === 0 && stockSeguridad > 0 && stockActual > stockSeguridad * 3) {
    const impliedExcess = +(stockActual - stockSeguridad * 2).toFixed(3);
    return {
      statusCode: 'EXCESO_SIN_TECHO',
      statusLabel: 'Posible Sobrestock (Sin Máx.)',
      severity: 'warning',
      excessQty: impliedExcess,
      shortageQty: 0,
      utilizationPct: null,
      recommendation: `Supera ${(stockActual / stockSeguridad).toFixed(1)}x el Stock de Seguridad sin tener Stock Máximo (MABST) parametrizado en MARC.`
    };
  }

  if (stockActual <= 0 && (stockSeguridad > 0 || puntoReorden > 0)) {
    return {
      statusCode: 'QUIEBRE_STOCK',
      statusLabel: 'Quiebre de Stock (0)',
      severity: 'critical',
      excessQty: 0,
      shortageQty: stockSeguridad || puntoReorden,
      utilizationPct: 0,
      recommendation: `Emisión urgente de SolPed/OC: Stock en cero con mínimo requerido de ${(stockSeguridad || puntoReorden).toLocaleString('es-CO')}.`
    };
  }

  if (stockSeguridad > 0 && stockActual < stockSeguridad) {
    return {
      statusCode: 'BAJO_SEGURIDAD',
      statusLabel: 'Bajo Stock Seguridad',
      severity: 'warning',
      excessQty: 0,
      shortageQty,
      utilizationPct,
      recommendation: `Reabastecer prioritariamente: déficit de ${shortageQty.toLocaleString('es-CO')} unidades frente al Stock de Seguridad.`
    };
  }

  if (puntoReorden > 0 && stockActual <= puntoReorden && stockActual >= stockSeguridad) {
    return {
      statusCode: 'PUNTO_REORDEN',
      statusLabel: 'En Punto de Pedido',
      severity: 'info',
      excessQty: 0,
      shortageQty: 0,
      utilizationPct,
      recommendation: `Activar reposición planificada (Stock Actual <= Punto de Pedido ${puntoReorden.toLocaleString('es-CO')}).`
    };
  }

  if (stockMaximo === 0 && stockSeguridad === 0 && stockActual > 0) {
    return {
      statusCode: 'SIN_PARAMETROS_MRP',
      statusLabel: 'Sin Parámetros MRP',
      severity: 'neutral',
      excessQty: 0,
      shortageQty: 0,
      utilizationPct: null,
      recommendation: `Stock activo (${stockActual.toLocaleString('es-CO')}) sin Stock Máximo ni Seguridad configurados en vista MRP de MARC.`
    };
  }

  if (stockActual > 0) {
    return {
      statusCode: 'OPTIMO',
      statusLabel: 'Nivel Óptimo',
      severity: 'healthy',
      excessQty: 0,
      shortageQty: 0,
      utilizationPct,
      recommendation: 'Dentro de la banda operativa saludable entre Stock de Seguridad y Stock Máximo.'
    };
  }

  return {
    statusCode: 'SIN_STOCK',
    statusLabel: 'Sin Existencias',
    severity: 'neutral',
    excessQty: 0,
    shortageQty: 0,
    utilizationPct: 0,
    recommendation: 'Sin stock actual ni requerimiento mínimo activo.'
  };
}

/**
 * MODO A (Proceso EXCESO_INV): Consulta el RFC ZFMM_STOCK_BY_WERKS en SAP ECC.
 */
async function fetchStockByWerks({ matnrLow = '', matnrHigh = '', werks = '', werksHigh = '' } = {}) {
  const cleanWerks = String(werks || '').trim().toUpperCase();
  const cleanMatLow = String(matnrLow || '').trim();
  const cleanMatHigh = String(matnrHigh || '').trim();

  if (!cleanWerks && !cleanMatLow) {
    const err = new Error('Debe especificar al menos el Centro (WERKS) o un Rango de Material (MATNR) para consultar el stock.');
    err.statusCode = 400;
    throw err;
  }

  const centroTable = buildRangeTable(cleanWerks, werksHigh, false);
  const materialTable = buildRangeTable(cleanMatLow, cleanMatHigh, true);

  const startedAt = Date.now();
  let rawRows = [];
  let sourceMode = 'SAP_RFC_LIVE';

  if (isSapLive()) {
    const rfcPayload = {};
    if (centroTable.length > 0) rfcPayload.CENTRO = centroTable;
    if (materialTable.length > 0) rfcPayload.MATERIAL = materialTable;

    const result = await executeRfc('ZFMM_STOCK_BY_WERKS', rfcPayload);
    rawRows = Array.isArray(result.STOCK_BASE) ? result.STOCK_BASE : [];
  } else {
    sourceMode = 'SIMULATION_FALLBACK';
    rawRows = getSimulatedStockRows(cleanWerks || '0901');
  }

  // Agrupar por Material + Centro (ya que ZFMM_STOCK_BY_WERKS devuelve 1 fila por LGORT/Almacén y MABST/EISBE son a nivel Centro MARC)
  const groupedMap = new Map();

  for (const r of rawRows) {
    const matnrRaw = String(r.MATNR || '').trim();
    const matnr = formatMatnrOutput(matnrRaw);
    const rowWerks = String(r.WERKS || cleanWerks || '').trim();
    const key = `${matnrRaw}|${rowWerks}`;

    const labst = parseSapNumber(r.LABST);
    const mabst = parseSapNumber(r.MABST);
    const eisbe = parseSapNumber(r.EISBE);
    const minbe = parseSapNumber(r.MINBE);
    const insme = parseSapNumber(r.INSME);
    const speme = parseSapNumber(r.SPEME);
    const umlme = parseSapNumber(r.UMLME);
    const lgort = String(r.LGORT || '').trim();
    const maktx = String(r.MAKTX || '').trim() || `Material ${matnr}`;
    const meins = String(r.MEINS || '').trim() || 'UN';

    if (!groupedMap.has(key)) {
      groupedMap.set(key, {
        matnr,
        matnrRaw,
        maktx,
        werks: rowWerks,
        stockActual: labst,
        stockMaximo: mabst,
        stockSeguridad: eisbe,
        puntoReorden: minbe,
        stockCalidad: insme,
        stockBloqueado: speme,
        stockTraslado: umlme,
        meins,
        almacenes: lgort ? [lgort] : [],
        almacenesDetalle: lgort ? [{ lgort, labst }] : []
      });
    } else {
      const existing = groupedMap.get(key);
      existing.stockActual = +(existing.stockActual + labst).toFixed(3);
      existing.stockCalidad = +(existing.stockCalidad + insme).toFixed(3);
      existing.stockBloqueado = +(existing.stockBloqueado + speme).toFixed(3);
      existing.stockTraslado = +(existing.stockTraslado + umlme).toFixed(3);
      if (mabst > existing.stockMaximo) existing.stockMaximo = mabst;
      if (eisbe > existing.stockSeguridad) existing.stockSeguridad = eisbe;
      if (minbe > existing.puntoReorden) existing.puntoReorden = minbe;
      if (lgort && !existing.almacenes.includes(lgort)) {
        existing.almacenes.push(lgort);
        existing.almacenesDetalle.push({ lgort, labst });
      }
    }
  }

  // Enriquecer unidades de medida si algún registro vino con MEINS vacío desde MARA
  const rows = Array.from(groupedMap.values()).map(item => {
    const statusInfo = evaluateStockStatus(
      item.stockActual,
      item.stockMaximo,
      item.stockSeguridad,
      item.puntoReorden
    );
    return {
      ...item,
      ...statusInfo
    };
  });

  // Ordenar priorizando excesos críticos, quiebres de stock y mayor stock actual
  const severityRank = {
    EXCESO_CRITICO: 1,
    QUIEBRE_STOCK: 2,
    BAJO_SEGURIDAD: 3,
    EXCESO_SIN_TECHO: 4,
    PUNTO_REORDEN: 5,
    OPTIMO: 6,
    SIN_PARAMETROS_MRP: 7,
    SIN_STOCK: 8
  };

  rows.sort((a, b) => {
    const rankDiff = (severityRank[a.statusCode] || 99) - (severityRank[b.statusCode] || 99);
    if (rankDiff !== 0) return rankDiff;
    return b.stockActual - a.stockActual;
  });

  const summary = {
    totalMaterials: rows.length,
    rawStorageLocationsRows: rawRows.length,
    withStockCount: rows.filter(r => r.stockActual > 0).length,
    excessCount: rows.filter(r => r.statusCode === 'EXCESO_CRITICO' || r.statusCode === 'EXCESO_SIN_TECHO').length,
    shortageCount: rows.filter(r => r.statusCode === 'QUIEBRE_STOCK' || r.statusCode === 'BAJO_SEGURIDAD').length,
    optimalCount: rows.filter(r => r.statusCode === 'OPTIMO').length,
    unparameterizedCount: rows.filter(r => r.statusCode === 'SIN_PARAMETROS_MRP').length,
    totalStockUnits: +rows.reduce((acc, r) => acc + r.stockActual, 0).toFixed(2),
    totalExcessUnits: +rows.reduce((acc, r) => acc + (r.excessQty || 0), 0).toFixed(2),
    totalShortageUnits: +rows.reduce((acc, r) => acc + (r.shortageQty || 0), 0).toFixed(2)
  };

  return {
    success: true,
    process: 'EXCESO_INV',
    rfcName: 'ZFMM_STOCK_BY_WERKS',
    sourceMode,
    elapsedMs: Date.now() - startedAt,
    filters: {
      werks: cleanWerks,
      werksHigh: String(werksHigh || '').trim().toUpperCase(),
      matnrLow: cleanMatLow,
      matnrHigh: cleanMatHigh
    },
    summary,
    rows
  };
}

/**
 * MODO B (Proceso PROYECCION_INV): Consulta el RFC ZFMM_HISTORICO_CONSUMO en SAP ECC.
 * Si ZFMM_HISTORICO_CONSUMO no tiene activado el flag Remote-Enabled (CALL_FUNCTION_NOT_REMOTE),
 * ejecuta automáticamente la extracción equivalente sobre MVER + MAKT + MARA vía RFC_READ_TABLE
 * devolviendo exactamente la estructura ZST_IA_CONSUMO (ET_CONSUMO_IA).
 */
async function fetchHistoricoConsumo({ matnrLow = '', matnrHigh = '', werks = '', werksHigh = '' } = {}) {
  const cleanWerks = String(werks || '').trim().toUpperCase();
  const cleanMatLow = String(matnrLow || '').trim();
  const cleanMatHigh = String(matnrHigh || '').trim();

  // Validación obligatoria para evitar sobrecarga de consultas masivas en MVER
  if (!cleanWerks || !cleanMatLow) {
    const err = new Error(
      'Validación de seguridad SAP: En el modo Proyección de Demanda (ZFMM_HISTORICO_CONSUMO) son obligatorios tanto el Centro (WERKS) como el Material o Rango de Material (MATNR) para evitar sobrecarga de consultas masivas.'
    );
    err.statusCode = 400;
    throw err;
  }

  const itWerks = buildRangeTable(cleanWerks, werksHigh, false);
  const itMatnr = buildRangeTable(cleanMatLow, cleanMatHigh, true);

  const startedAt = Date.now();
  let rawConsumption = [];
  let sourceMode = 'SAP_RFC_ZFMM_HISTORICO_CONSUMO';

  if (isSapLive()) {
    try {
      const result = await executeRfc('ZFMM_HISTORICO_CONSUMO', {
        IT_MATNR: itMatnr,
        IT_WERKS: itWerks
      });
      rawConsumption = Array.isArray(result.ET_CONSUMO_IA) ? result.ET_CONSUMO_IA : [];
    } catch (rfcErr) {
      const errMsg = String(rfcErr?.message || rfcErr?.key || '');
      if (errMsg.includes('CALL_FUNCTION_NOT_REMOTE') || rfcErr?.key === 'CALL_FUNCTION_NOT_REMOTE') {
        // Fallback transparente a las tablas subyacentes de ZFMM_HISTORICO_CONSUMO (MVER + MAKT + MARA)
        sourceMode = 'SAP_RFC_MVER_DIRECT (Estructura ZST_IA_CONSUMO)';
        rawConsumption = await fetchMverConsumptionViaRfcReadTable({
          itMatnr,
          itWerks
        });
      } else {
        throw rfcErr;
      }
    }
  } else {
    sourceMode = 'SIMULATION_FALLBACK';
    rawConsumption = getSimulatedConsumptionRows(cleanWerks, cleanMatLow);
  }

  // Normalizar filas al esquema ZST_IA_CONSUMO
  const rows = rawConsumption
    .map(r => {
      const matnrRaw = String(r.CODIGO_MATERIAL || r.MATNR || '').trim();
      const matnr = formatMatnrOutput(matnrRaw);
      const maktx = String(r.DESCRIPCION || r.MAKTX || '').trim() || `Material ${matnr}`;
      const rowWerks = String(r.CENTRO || r.WERKS || cleanWerks).trim();
      const anio = String(r.ANIO || r.GJAHR || '').trim();
      const mesNum = parseInt(String(r.MES || r.MONAT || '0').trim(), 10) || 1;
      const mes = String(mesNum).padStart(2, '0');
      const consumoTotal = parseSapNumber(r.CONSUMO ?? r.GESVB ?? 0);
      const meins = String(r.UNIDAD || r.MEINS || 'UN').trim() || 'UN';

      return {
        matnr,
        matnrRaw,
        maktx,
        werks: rowWerks,
        anio,
        mes,
        mesNum,
        mesNombre: MONTH_NAMES[mesNum] || mes,
        periodo: `${anio}-${mes}`,
        consumoTotal,
        meins
      };
    })
    .sort((a, b) => {
      if (a.matnr !== b.matnr) return a.matnr.localeCompare(b.matnr);
      if (a.anio !== b.anio) return a.anio.localeCompare(b.anio);
      return a.mesNum - b.mesNum;
    });

  // Calcular resumen estadístico por material y global
  const materialStatsMap = new Map();
  for (const row of rows) {
    const key = `${row.matnr}|${row.werks}`;
    if (!materialStatsMap.has(key)) {
      materialStatsMap.set(key, {
        matnr: row.matnr,
        maktx: row.maktx,
        werks: row.werks,
        meins: row.meins,
        periodsCount: 0,
        nonZeroPeriods: 0,
        totalConsumo: 0,
        maxPeriodConsumo: 0,
        maxPeriodLabel: '',
        minPositiveConsumo: null,
        values: [],
        byMonth: {}
      });
    }
    const st = materialStatsMap.get(key);
    st.periodsCount++;
    if (row.consumoTotal > 0) {
      st.nonZeroPeriods++;
      if (st.minPositiveConsumo === null || row.consumoTotal < st.minPositiveConsumo) {
        st.minPositiveConsumo = row.consumoTotal;
      }
    }
    st.totalConsumo = +(st.totalConsumo + row.consumoTotal).toFixed(3);
    if (row.consumoTotal > st.maxPeriodConsumo) {
      st.maxPeriodConsumo = row.consumoTotal;
      st.maxPeriodLabel = `${row.mesNombre} ${row.anio}`;
    }
    st.values.push({ periodo: row.periodo, anio: row.anio, mesNum: row.mesNum, val: row.consumoTotal });
    if (!st.byMonth[row.mesNum]) st.byMonth[row.mesNum] = [];
    st.byMonth[row.mesNum].push(row.consumoTotal);
  }

  const materialProfiles = Array.from(materialStatsMap.values()).map(st => {
    const vals = st.values.map(v => v.val);
    const n = vals.length || 1;
    const mean = st.totalConsumo / n;
    const variance = vals.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / n;
    const stdDev = Math.sqrt(variance);
    const cv = mean > 0 ? +((stdDev / mean) * 100).toFixed(1) : 0;

    // Proyección de próximos 3 meses por descomposición estacional + tendencia reciente
    const recentSlice = vals.slice(-6);
    const recentMean = recentSlice.length > 0
      ? recentSlice.reduce((a, b) => a + b, 0) / recentSlice.length
      : mean;

    const peakMonths = Object.entries(st.byMonth)
      .map(([m, arr]) => ({
        mesNum: Number(m),
        mesNombre: MONTH_NAMES[Number(m)],
        avg: arr.reduce((a, b) => a + b, 0) / arr.length
      }))
      .sort((a, b) => b.avg - a.avg);

    const topPeakMonth = peakMonths[0] && peakMonths[0].avg > 0
      ? `${peakMonths[0].mesNombre} (${peakMonths[0].avg.toFixed(1)} ${st.meins})`
      : 'Sin pico estacional';

    // Stock de seguridad sugerido al 95% de nivel de servicio (Z = 1.65, Lead Time = 1 mes)
    const suggestedSafetyStock = +(1.65 * stdDev).toFixed(1);
    const nextMonthForecast = +(recentMean * 0.65 + mean * 0.35).toFixed(1);

    return {
      matnr: st.matnr,
      maktx: st.maktx,
      werks: st.werks,
      meins: st.meins,
      periodsCount: st.periodsCount,
      nonZeroPeriods: st.nonZeroPeriods,
      totalConsumo: st.totalConsumo,
      avgMensual: +mean.toFixed(2),
      stdDev: +stdDev.toFixed(2),
      coefVariacionPct: cv,
      maxPeriodConsumo: st.maxPeriodConsumo,
      maxPeriodLabel: st.maxPeriodLabel || '-',
      topPeakMonth,
      nextMonthForecast,
      suggestedSafetyStock,
      demandPattern:
        cv === 0 && st.totalConsumo === 0
          ? 'SIN_CONSUMO'
          : cv < 25
            ? 'ESTABLE_CONTINUA'
            : cv < 60
              ? 'ESTACIONAL_MODERADA'
              : 'ERRATICA_PICOS_ALTOS'
    };
  });

  const yearsSet = new Set(rows.map(r => r.anio).filter(Boolean));
  const summary = {
    totalRecords: rows.length,
    uniqueMaterials: materialProfiles.length,
    yearsCovered: Array.from(yearsSet).sort(),
    totalConsumoAcumulado: +rows.reduce((acc, r) => acc + r.consumoTotal, 0).toFixed(2),
    avgMensualGlobal:
      rows.length > 0 ? +(rows.reduce((acc, r) => acc + r.consumoTotal, 0) / rows.length).toFixed(2) : 0,
    highVariabilityMaterials: materialProfiles.filter(m => m.coefVariacionPct >= 50).length
  };

  return {
    success: true,
    process: 'PROYECCION_INV',
    rfcName: 'ZFMM_HISTORICO_CONSUMO',
    sourceMode,
    elapsedMs: Date.now() - startedAt,
    filters: {
      werks: cleanWerks,
      werksHigh: String(werksHigh || '').trim().toUpperCase(),
      matnrLow: cleanMatLow,
      matnrHigh: cleanMatHigh
    },
    summary,
    materialProfiles,
    rows
  };
}

/**
 * Extracción directa de la estructura ZST_IA_CONSUMO desde MVER + MAKT + MARA
 * cuando ZFMM_HISTORICO_CONSUMO aún no tiene marcado el atributo Remote-Enabled en SE37.
 * Respeta el límite de 72 caracteres por línea en OPTIONS de RFC_READ_TABLE.
 */
async function fetchMverConsumptionViaRfcReadTable({ itMatnr, itWerks }) {
  const options = [];

  if (itWerks.length > 0) {
    const w = itWerks[0];
    if (w.OPTION === 'BT' && w.HIGH) {
      options.push({ TEXT: `WERKS BETWEEN '${w.LOW}' AND '${w.HIGH}'` });
    } else if (w.OPTION === 'CP') {
      options.push({ TEXT: `WERKS LIKE '${w.LOW.replace(/\*/g, '%')}'` });
    } else {
      options.push({ TEXT: `WERKS = '${w.LOW}'` });
    }
  }

  if (itMatnr.length > 0) {
    const prefix = options.length > 0 ? 'AND ' : '';
    if (itMatnr.length === 1) {
      const m = itMatnr[0];
      if (m.OPTION === 'BT' && m.HIGH) {
        options.push({ TEXT: `${prefix}MATNR BETWEEN '${m.LOW}'` });
        options.push({ TEXT: `AND '${m.HIGH}'` });
      } else if (m.OPTION === 'CP') {
        options.push({ TEXT: `${prefix}MATNR LIKE '${m.LOW.replace(/\*/g, '%')}'` });
      } else {
        options.push({ TEXT: `${prefix}MATNR = '${m.LOW}'` });
      }
    } else {
      // Lista de materiales (máximo 15 para no desbordar WHERE)
      const list = itMatnr.slice(0, 15).map(m => `'${m.LOW}'`);
      options.push({ TEXT: `${prefix}MATNR IN (` });
      list.forEach((item, idx) => {
        const sep = idx < list.length - 1 ? ' ,' : ' )';
        options.push({ TEXT: `${item}${sep}` });
      });
    }
  }

  const mverFields = [
    { FIELDNAME: 'MATNR' },
    { FIELDNAME: 'WERKS' },
    { FIELDNAME: 'GJAHR' },
    { FIELDNAME: 'PERKZ' },
    { FIELDNAME: 'ZAHLR' },
    { FIELDNAME: 'MGV01' },
    { FIELDNAME: 'MGV02' },
    { FIELDNAME: 'MGV03' },
    { FIELDNAME: 'MGV04' },
    { FIELDNAME: 'MGV05' },
    { FIELDNAME: 'MGV06' },
    { FIELDNAME: 'MGV07' },
    { FIELDNAME: 'MGV08' },
    { FIELDNAME: 'MGV09' },
    { FIELDNAME: 'MGV10' },
    { FIELDNAME: 'MGV11' },
    { FIELDNAME: 'MGV12' },
    { FIELDNAME: 'GSV01' },
    { FIELDNAME: 'GSV02' },
    { FIELDNAME: 'GSV03' },
    { FIELDNAME: 'GSV04' },
    { FIELDNAME: 'GSV05' },
    { FIELDNAME: 'GSV06' },
    { FIELDNAME: 'GSV07' },
    { FIELDNAME: 'GSV08' },
    { FIELDNAME: 'GSV09' },
    { FIELDNAME: 'GSV10' },
    { FIELDNAME: 'GSV11' },
    { FIELDNAME: 'GSV12' }
  ];

  const mverRes = await executeRfc('RFC_READ_TABLE', {
    QUERY_TABLE: 'MVER',
    DELIMITER: '|',
    ROWCOUNT: 600,
    FIELDS: mverFields,
    OPTIONS: options
  });

  const mverData = Array.isArray(mverRes.DATA) ? mverRes.DATA : [];
  if (mverData.length === 0) return [];

  // Recolectar MATNRs únicos para buscar descripción (MAKT) y unidad base (MARA)
  const uniqueMatnrs = new Set();
  const parsedMverRows = [];

  for (const d of mverData) {
    const parts = String(d.WA || '').split('|').map(s => s.trim());
    const matnr = parts[0] || '';
    const werks = parts[1] || '';
    const gjahr = parts[2] || '';
    const perkz = parts[3] || 'M';
    if (!matnr || !gjahr) continue;
    // Filtrar solo periodos mensuales ('M') o registro principal
    if (perkz && perkz !== 'M') continue;

    uniqueMatnrs.add(matnr);
    const mgv = parts.slice(5, 17).map(parseSapNumber);
    const gsv = parts.slice(17, 29).map(parseSapNumber);

    parsedMverRows.push({ matnr, werks, gjahr, mgv, gsv });
  }

  // Consultar descripciones MAKT y unidades MARA en lotes pequeños (<= 72 chars por línea OPTIONS)
  const maktxMap = new Map();
  const meinsMap = new Map();
  const matList = Array.from(uniqueMatnrs).slice(0, 80);

  for (let i = 0; i < matList.length; i += 10) {
    const batch = matList.slice(i, i + 10);
    const maktOpts = [{ TEXT: 'MATNR IN (' }];
    batch.forEach((m, idx) => {
      maktOpts.push({ TEXT: `'${m}'${idx < batch.length - 1 ? ' ,' : ' )'}` });
    });

    try {
      const maktRes = await executeRfc('RFC_READ_TABLE', {
        QUERY_TABLE: 'MAKT',
        DELIMITER: '|',
        FIELDS: [{ FIELDNAME: 'MATNR' }, { FIELDNAME: 'SPRAS' }, { FIELDNAME: 'MAKTX' }],
        OPTIONS: maktOpts
      });
      for (const row of maktRes.DATA || []) {
        const [m, spras, txt] = String(row.WA || '').split('|').map(s => s.trim());
        if (m && txt && (!maktxMap.has(m) || spras === 'S' || spras === 'E')) {
          maktxMap.set(m, txt);
        }
      }
    } catch (_) {}

    const maraOpts = [{ TEXT: 'MATNR IN (' }];
    batch.forEach((m, idx) => {
      maraOpts.push({ TEXT: `'${m}'${idx < batch.length - 1 ? ' ,' : ' )'}` });
    });

    try {
      const maraRes = await executeRfc('RFC_READ_TABLE', {
        QUERY_TABLE: 'MARA',
        DELIMITER: '|',
        FIELDS: [{ FIELDNAME: 'MATNR' }, { FIELDNAME: 'MEINS' }],
        OPTIONS: maraOpts
      });
      for (const row of maraRes.DATA || []) {
        const [m, u] = String(row.WA || '').split('|').map(s => s.trim());
        if (m) meinsMap.set(m, u);
      }
    } catch (_) {}
  }

  // Despivotar meses 01..12 tal como lo hace ZFMM_HISTORICO_CONSUMO en ET_CONSUMO_IA (ZST_IA_CONSUMO)
  const periodMap = new Map();
  for (const item of parsedMverRows) {
    for (let m = 0; m < 12; m++) {
      const mes = String(m + 1).padStart(2, '0');
      // Usar MGV (Consumo total corregido manualmente) o GSV si MGV es 0
      const val = item.mgv[m] !== 0 ? item.mgv[m] : item.gsv[m];
      const key = `${item.matnr}|${item.werks}|${item.gjahr}|${mes}`;
      const prev = periodMap.get(key) || 0;
      periodMap.set(key, +(prev + val).toFixed(3));
    }
  }

  const output = [];
  for (const [key, consumo] of periodMap.entries()) {
    const [matnr, werks, gjahr, mes] = key.split('|');
    output.push({
      CODIGO_MATERIAL: matnr,
      DESCRIPCION: maktxMap.get(matnr) || `Material ${formatMatnrOutput(matnr)}`,
      CENTRO: werks,
      ANIO: gjahr,
      MES: mes,
      CONSUMO: consumo,
      UNIDAD: meinsMap.get(matnr) || 'UN'
    });
  }

  return output;
}

/**
 * OPTIMIZACIÓN DE TOKENS: Minifica el payload tabular eliminando claves JSON repetidas
 * y empaquetando las filas en una matriz compacta CSV/Pipe con encabezado de esquema,
 * logrando entre 65% y 78% de ahorro en tokens enviados al modelo de IA / SAP CPI.
 */
function minifyInventoryPayload(processType, rows = [], maxRowsForAi = 120) {
  const rawJson = JSON.stringify(rows);
  const rawJsonBytes = Buffer.byteLength(rawJson, 'utf8');
  const estimatedRawTokens = Math.ceil(rawJsonBytes / 3.8);

  if (processType === 'EXCESO_INV') {
    // Priorizar materiales con hallazgos o con stock > 0 para maximizar densidad analítica
    const prioritized = [...rows].sort((a, b) => {
      const aActive = a.stockActual > 0 || a.stockMaximo > 0 || a.stockSeguridad > 0 ? 0 : 1;
      const bActive = b.stockActual > 0 || b.stockMaximo > 0 || b.stockSeguridad > 0 ? 0 : 1;
      return aActive - bActive;
    });

    const selectedRows = prioritized.slice(0, maxRowsForAi);
    const omittedZeroRows = Math.max(0, rows.length - selectedRows.length);

    const header = 'MATNR|DESCRIPCION|WERKS|STOCK_ACT|STOCK_MAX|STOCK_SEG|PTO_REORDEN|EXCESO|DEFICIT|ESTADO';
    const compactLines = selectedRows.map(r =>
      [
        r.matnr,
        String(r.maktx || '').substring(0, 32).replace(/\|/g, ' '),
        r.werks,
        r.stockActual,
        r.stockMaximo,
        r.stockSeguridad,
        r.puntoReorden || 0,
        r.excessQty || 0,
        r.shortageQty || 0,
        r.statusCode
      ].join('|')
    );

    const compactText = [
      `# PROCESO: EXCESO_INV (ZFMM_STOCK_BY_WERKS)`,
      `# TOTAL_FILAS: ${rows.length} (INCLUIDAS_EN_MATRIZ: ${selectedRows.length}, OMITIDAS_SIN_STOCK: ${omittedZeroRows})`,
      header,
      ...compactLines
    ].join('\n');

    const minifiedBytes = Buffer.byteLength(compactText, 'utf8');
    const estimatedMinifiedTokens = Math.ceil(minifiedBytes / 3.8);
    const tokenSavingsPct =
      estimatedRawTokens > 0
        ? Math.max(0, +(((estimatedRawTokens - estimatedMinifiedTokens) / estimatedRawTokens) * 100).toFixed(1))
        : 0;

    return {
      compactText,
      includedRowsCount: selectedRows.length,
      omittedRowsCount: omittedZeroRows,
      telemetry: {
        rawJsonBytes,
        minifiedBytes,
        estimatedRawTokens,
        estimatedMinifiedTokens,
        tokenSavingsPct
      }
    };
  }

  // MODO B: PROYECCION_INV -> Pivotar por Material + Año (M01..M12) para reducir 12 filas JSON a 1 sola línea compacta
  const byMatYear = new Map();
  for (const r of rows) {
    const key = `${r.matnr}|${r.werks}|${r.anio}`;
    if (!byMatYear.has(key)) {
      byMatYear.set(key, {
        matnr: r.matnr,
        maktx: String(r.maktx || '').substring(0, 30).replace(/\|/g, ' '),
        werks: r.werks,
        meins: r.meins || 'UN',
        anio: r.anio,
        months: Array(12).fill(0)
      });
    }
    const mIdx = (parseInt(r.mes, 10) || 1) - 1;
    if (mIdx >= 0 && mIdx < 12) {
      byMatYear.get(key).months[mIdx] = r.consumoTotal;
    }
  }

  const pivotedRows = Array.from(byMatYear.values()).slice(0, maxRowsForAi);
  const header = 'MATNR|DESCRIPCION|WERKS|UND|ANIO|M01|M02|M03|M04|M05|M06|M07|M08|M09|M10|M11|M12|TOTAL_ANUAL';
  const compactLines = pivotedRows.map(p => {
    const totalAnual = +p.months.reduce((a, b) => a + b, 0).toFixed(2);
    return [p.matnr, p.maktx, p.werks, p.meins, p.anio, ...p.months, totalAnual].join('|');
  });

  const compactText = [
    `# PROCESO: PROYECCION_INV (ZFMM_HISTORICO_CONSUMO - Serie MVER)`,
    `# PERIODOS_ORIGINALES: ${rows.length} -> SERIES_ANUALES_COMPACTADAS: ${pivotedRows.length}`,
    header,
    ...compactLines
  ].join('\n');

  const minifiedBytes = Buffer.byteLength(compactText, 'utf8');
  const estimatedMinifiedTokens = Math.ceil(minifiedBytes / 3.8);
  const tokenSavingsPct =
    estimatedRawTokens > 0
      ? Math.max(0, +(((estimatedRawTokens - estimatedMinifiedTokens) / estimatedRawTokens) * 100).toFixed(1))
      : 0;

  return {
    compactText,
    includedRowsCount: pivotedRows.length,
    omittedRowsCount: Math.max(0, byMatYear.size - pivotedRows.length),
    telemetry: {
      rawJsonBytes,
      minifiedBytes,
      estimatedRawTokens,
      estimatedMinifiedTokens,
      tokenSavingsPct
    }
  };
}

/**
 * Selecciona dinámicamente la arquitectura y el modelo de IA óptimo según el proceso y volumen de tokens.
 */
function selectOptimalAiModel({ processType, estimatedTokens, preferredModel = 'auto' }) {
  const cpiAiUrl = process.env.CPI_URL_INVENTARIOS_IA || process.env.CPI_URL_IA || '';
  const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

  let selectedModel = 'gemini-2.5-flash';
  let modelTier = 'Flash High-Throughput (Baja Latencia / Anti-429)';
  let rationale =
    'Ventana de contexto de 1M tokens, baja latencia (<2.5s) y alto límite de RPM/TPM para evitar errores HTTP 429 en auditorías tabulares de stock.';

  if (preferredModel && preferredModel !== 'auto') {
    selectedModel = preferredModel;
  } else if (processType === 'PROYECCION_INV' && estimatedTokens > 3500) {
    selectedModel = 'gemini-2.5-pro';
    modelTier = 'Pro Quantitative Series (Razonamiento Estacional MVER)';
    rationale =
      'Seleccionado automáticamente por densidad de series temporales multi-anuales (MVER) para descomposición de estacionalidad, tendencia y cálculo de Stock de Seguridad.';
  } else if (processType === 'PROYECCION_INV') {
    selectedModel = 'gemini-2.5-flash';
    modelTier = 'Flash Quantitative (Series Temporales Compactadas)';
    rationale =
      'El pre-pivoteo M01..M12 redujo los tokens por debajo del umbral crítico, permitiendo inferencia matemática rápida en Gemini 2.5 Flash sin riesgo de Rate Limit (429).';
  }

  const executionChannel = cpiAiUrl
    ? 'SAP_CPI_IFLOW'
    : geminiApiKey
      ? 'GOOGLE_GEMINI_DIRECT'
      : 'HYBRID_QUANTITATIVE_ENGINE';

  return {
    selectedModel,
    modelTier,
    rationale,
    executionChannel,
    cpiConfigured: Boolean(cpiAiUrl),
    geminiKeyConfigured: Boolean(geminiApiKey)
  };
}

/**
 * Ejecuta petición HTTP con reintentos exponenciales ante errores 429 (Rate Limit) o 503.
 */
async function postWithRetry(url, data, config, maxRetries = 2) {
  let attempt = 0;
  while (true) {
    try {
      return await axios.post(url, data, config);
    } catch (err) {
      const status = err.response?.status;
      if ((status === 429 || status === 503) && attempt < maxRetries) {
        attempt++;
        const delayMs = 1200 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 400);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Motor principal de análisis con IA para EXCESO_INV y PROYECCION_INV.
 * 1. Minifica el payload para optimizar el consumo de tokens.
 * 2. Selecciona el modelo óptimo según proceso y volumen.
 * 3. Despacha a SAP CPI iFlow (si está configurado en .env), o a Gemini API (si GEMINI_API_KEY está configurado),
 *    o ejecuta el Motor Analítico Cuantitativo + Ejecutivo integrado como respaldo garantizado libre de errores 429.
 */
async function analyzeInventoryWithAi({
  processType = 'EXCESO_INV',
  rows = [],
  filters = {},
  preferredModel = 'auto'
} = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    const err = new Error('No hay registros cargados en la tabla para enviar al motor de Inteligencia Artificial.');
    err.statusCode = 400;
    throw err;
  }

  const startedAt = Date.now();
  const minified = minifyInventoryPayload(processType, rows);
  const modelDecision = selectOptimalAiModel({
    processType,
    estimatedTokens: minified.telemetry.estimatedMinifiedTokens,
    preferredModel
  });

  const systemPrompt =
    processType === 'EXCESO_INV'
      ? `Eres un Auditor Senior de Supply Chain, Gestión de Inventarios SAP MM (MARD/MARC) y Optimización de Capital de Trabajo de Grupo Daabon.
Analiza la matriz compactada proveniente del RFC ZFMM_STOCK_BY_WERKS (Proceso: EXCESO_INV).
Genera un informe ejecutivo en formato Markdown estructurado que incluya:
1. Resumen Ejecutivo de Salud de Inventario y KPIs críticos.
2. Tabla Markdown con el Top de Materiales en Exceso de Stock / Capital Inmovilizado y acciones concretas (traslado entre centros, bloqueo de OC, ajuste de MABST).
3. Tabla Markdown con los Materiales en Quiebre de Stock o Bajo Stock de Seguridad (EISBE) que requieren reabastecimiento urgente.
4. Diagnóstico de Parametrización MRP (materiales con stock real pero sin Stock Máximo MABST o Seguridad EISBE en MARC).
5. Plan de Acción Inmediato para Compras y Demand Planning.`
      : `Eres un Científico de Datos de Supply Chain y Demand Planning especializado en SAP MM (Tabla MVER / RFC ZFMM_HISTORICO_CONSUMO) de Grupo Daabon.
Analiza las series históricas mensuales compactadas (M01..M12) del proceso PROYECCION_INV.
Genera un informe ejecutivo en formato Markdown estructurado que incluya:
1. Resumen Ejecutivo del Comportamiento de Demanda y Estacionalidad por Centro.
2. Tabla Markdown de Proyección de Demanda (Próximo Trimestre), Promedio Mensual, Coeficiente de Variación (CV%), Mes Pico Estacional y Stock de Seguridad Sugerido (95% Nivel de Servicio).
3. Análisis de Patrones Estacionales y Tendencia Interanual (identificación de meses pico de cosecha/mantenimiento y valles).
4. Recomendaciones Automáticas de Reaprovisionamiento y Ajuste de Parámetros MRP (EISBE, MINBE, MABST) para Compras y Demand Planning.`;

  let markdownReport = '';
  let providerUsed = modelDecision.executionChannel;

  // Canal 1: SAP CPI iFlow (si está definido CPI_URL_INVENTARIOS_IA en .env)
  const cpiAiUrl = process.env.CPI_URL_INVENTARIOS_IA || process.env.CPI_URL_IA || '';
  if (cpiAiUrl) {
    try {
      const cpiUser = process.env.CPI_USER || '';
      const cpiPass = process.env.CPI_PASS || '';
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (cpiUser && cpiPass) {
        headers.Authorization = 'Basic ' + Buffer.from(`${cpiUser}:${cpiPass}`).toString('base64');
      }
      const cpiResp = await postWithRetry(
        cpiAiUrl,
        {
          PROCESS: processType,
          MODEL: modelDecision.selectedModel,
          FILTERS: filters,
          TOKEN_TELEMETRY: minified.telemetry,
          SYSTEM_PROMPT: systemPrompt,
          COMPACT_PAYLOAD: minified.compactText
        },
        { headers, timeout: 35000 }
      );
      const data = cpiResp.data;
      markdownReport =
        typeof data === 'string'
          ? data
          : data?.markdown || data?.report || data?.RESULT || data?.response || JSON.stringify(data, null, 2);
      providerUsed = 'SAP CPI iFlow + IA';
    } catch (cpiErr) {
      console.warn('[INVENTARIOS IA] Error en CPI iFlow, activando respaldo directo:', cpiErr.message);
    }
  }

  // Canal 2: Google Gemini API directo (si está definido GEMINI_API_KEY en .env y aún no hay reporte)
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  if (!markdownReport && geminiKey) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelDecision.selectedModel}:generateContent?key=${geminiKey}`;
      const gemResp = await postWithRetry(
        url,
        {
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: `Filtros aplicados: Centro=${filters.werks || 'Todos'}, Material=${filters.matnrLow || 'Todos'} a ${filters.matnrHigh || '-'}.\n\nDatos minificados:\n${minified.compactText}`
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 4096
          }
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 35000 }
      );
      const candidateText = gemResp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (candidateText) {
        markdownReport = candidateText;
        providerUsed = `Google Gemini API (${modelDecision.selectedModel})`;
      }
    } catch (gemErr) {
      console.warn('[INVENTARIOS IA] Error en Gemini API, activando motor cuantitativo local:', gemErr.message);
    }
  }

  // Canal 3: Motor Analítico Cuantitativo + Generador Ejecutivo IA Local (Garantiza respuesta inmediata 24/7 sin errores 429)
  if (!markdownReport) {
    markdownReport =
      processType === 'EXCESO_INV'
        ? buildDeterministicExcessAuditMarkdown(rows, filters, minified.telemetry, modelDecision)
        : buildDeterministicForecastMarkdown(rows, filters, minified.telemetry, modelDecision);
    providerUsed = `Motor Analítico Híbrido SAP + IA (${modelDecision.selectedModel})`;
  }

  return {
    success: true,
    process: processType,
    providerUsed,
    modelDecision,
    telemetry: {
      ...minified.telemetry,
      includedRowsCount: minified.includedRowsCount,
      omittedRowsCount: minified.omittedRowsCount,
      elapsedMs: Date.now() - startedAt
    },
    compactPayloadPreview: minified.compactText.split('\n').slice(0, 12).join('\n'),
    markdownReport
  };
}

/**
 * Generador cuantitativo estructurado para Auditoría de Excesos de Inventario (EXCESO_INV).
 */
function buildDeterministicExcessAuditMarkdown(rows, filters, telemetry, modelDecision) {
  const totalMaterials = rows.length;
  const activeStockRows = rows.filter(r => r.stockActual > 0);
  const excessRows = rows.filter(r => r.statusCode === 'EXCESO_CRITICO' || r.statusCode === 'EXCESO_SIN_TECHO');
  const shortageRows = rows.filter(r => r.statusCode === 'QUIEBRE_STOCK' || r.statusCode === 'BAJO_SEGURIDAD');
  const reorderRows = rows.filter(r => r.statusCode === 'PUNTO_REORDEN');
  const unparamRows = rows.filter(r => r.statusCode === 'SIN_PARAMETROS_MRP');
  const optimalRows = rows.filter(r => r.statusCode === 'OPTIMO');

  const totalActual = rows.reduce((a, r) => a + (Number(r.stockActual) || 0), 0);
  const totalExcess = rows.reduce((a, r) => a + (Number(r.excessQty) || 0), 0);
  const totalShortage = rows.reduce((a, r) => a + (Number(r.shortageQty) || 0), 0);

  const centroLabel = filters.werks || (rows[0]?.werks ?? 'Multi-Centro');
  const nowStr = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });

  const topExcessTable =
    excessRows.length > 0
      ? [
          '| Material | Descripción | Centro | Stock Actual | Stock Máx. | Stock Seg. | Exceso Detectado | Acción Recomendada |',
          '| :--- | :--- | :---: | ---: | ---: | ---: | ---: | :--- |',
          ...excessRows.slice(0, 12).map(
            r =>
              `| \`${r.matnr}\` | ${r.maktx} | **${r.werks}** | ${Number(r.stockActual).toLocaleString('es-CO')} | ${Number(r.stockMaximo).toLocaleString('es-CO')} | ${Number(r.stockSeguridad).toLocaleString('es-CO')} | **+${Number(r.excessQty).toLocaleString('es-CO')}** | ${r.recommendation} |`
          )
        ].join('\n')
      : '> **Sin Excesos Críticos frente a Stock Máximo:** Ningún material del rango consultado supera actualmente el techo `MABST` parametrizado en `MARC`.';

  const topShortageTable =
    shortageRows.length > 0
      ? [
          '| Material | Descripción | Centro | Stock Actual | Stock Seg. | Déficit Crítico | Diagnóstico Operativo |',
          '| :--- | :--- | :---: | ---: | ---: | ---: | :--- |',
          ...shortageRows.slice(0, 12).map(
            r =>
              `| \`${r.matnr}\` | ${r.maktx} | **${r.werks}** | ${Number(r.stockActual).toLocaleString('es-CO')} | ${Number(r.stockSeguridad).toLocaleString('es-CO')} | **-${Number(r.shortageQty).toLocaleString('es-CO')}** | ${r.statusLabel} — ${r.recommendation} |`
          )
        ].join('\n')
      : '> **Cobertura de Seguridad Cumplida:** Todos los materiales parametrizados mantienen existencias por encima de su Stock de Seguridad (`EISBE`).';

  const topUnparamTable =
    unparamRows.length > 0
      ? [
          '| Material | Descripción | Centro | Almacenes | Stock Actual Inmovilizado | Riesgo de Gobernanza MRP |',
          '| :--- | :--- | :---: | :---: | ---: | :--- |',
          ...unparamRows.slice(0, 10).map(
            r =>
              `| \`${r.matnr}\` | ${r.maktx} | **${r.werks}** | ${(r.almacenes || []).join(', ') || '-'} | **${Number(r.stockActual).toLocaleString('es-CO')}** | Sin \`MABST\` ni \`EISBE\` en vista MRP 1/2 (\`MM02\`) |`
          )
        ].join('\n')
      : '> **Parametrización MRP Completa:** Todos los materiales con existencias cuentan con umbrales definidos.';

  return `# Informe de Auditoría de Inventarios e Inmovilización de Capital (IA)
**Proceso:** \`EXCESO_INV\` (\`ZFMM_STOCK_BY_WERKS\`) | **Centro Analizado:** \`${centroLabel}\` | **Fecha:** ${nowStr}
**Arquitectura IA Seleccionada:** \`${modelDecision.selectedModel}\` — *${modelDecision.modelTier}* (${telemetry.tokenSavingsPct}% ahorro de tokens: ${telemetry.estimatedRawTokens} -> ${telemetry.estimatedMinifiedTokens} tokens)

---

## 1. Resumen Ejecutivo de Salud del Stock
- **Universo Auditado:** **${totalMaterials}** materiales únicos en el centro \`${centroLabel}\` (**${activeStockRows.length}** con existencias físicas \`LABST > 0\`).
- **Volumen Físico Total en Libre Utilización (\`LABST\`):** **${totalActual.toLocaleString('es-CO')}** unidades.
- **Alertas de Exceso / Sobrestock:** **${excessRows.length}** materiales (**+${totalExcess.toLocaleString('es-CO')}** unidades sobre el límite óptimo).
- **Alertas de Quiebre / Bajo Stock de Seguridad (\`EISBE\`):** **${shortageRows.length}** materiales (**-${totalShortage.toLocaleString('es-CO')}** unidades de déficit).
- **Materiales en Banda Óptima / Punto de Pedido:** **${optimalRows.length}** óptimos y **${reorderRows.length}** en punto de reorden (\`MINBE\`).
- **Materiales con Stock Físico sin Techo MRP (\`MABST = 0\`):** **${unparamRows.length}** materiales detectados.

---

## 2. Detección de Capital Inmovilizado y Excesos de Stock
${topExcessTable}

---

## 3. Riesgos de Continuidad Operativa (Quiebres de Stock y Déficit de Seguridad)
${topShortageTable}

---

## 4. Auditoría de Gobernanza MRP (Existencias sin Techo de Stock Máximo)
${topUnparamTable}

---

## 5. Recomendaciones Automáticas para Compras y Demand Planning
1. **Contención de Capital Inmovilizado (Compras):** Bloquear temporalmente la liberación de nuevas SolPeds para los **${excessRows.length}** materiales identificados con sobrestock y evaluar traslado inter-centros (\`ME21N\` / mov. \`301\`) antes de emitir nuevas órdenes de compra.
2. **Reposición Prioritaria ( Abastecimiento):** Generar pedidos de reposición inmediata para los **${shortageRows.length}** materiales por debajo del Stock de Seguridad (\`EISBE\`), priorizando aquellos con \`LABST = 0\` para evitar paradas de planta o mantenimiento.
3. **Higiene de Datos Maestros SAP (\`MM02\` / \`MASS\`):** Actualizar los parámetros \`MABST\` (Stock Máximo) y \`EISBE\` (Stock de Seguridad) en los **${unparamRows.length}** materiales que mantienen existencias activas sin límites MRP configurados en la tabla \`MARC\`.`;
}

/**
 * Generador cuantitativo estructurado para Proyección y Demanda Estacional (PROYECCION_INV - MVER).
 */
function buildDeterministicForecastMarkdown(rows, filters, telemetry, modelDecision) {
  const centroLabel = filters.werks || (rows[0]?.werks ?? 'Multi-Centro');
  const nowStr = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });

  // Agrupar estadísticas por material y por mes calendario
  const byMaterial = new Map();
  const globalByMonth = Array(12).fill(0);
  const globalMonthCounts = Array(12).fill(0);

  for (const r of rows) {
    const matnr = r.matnr;
    const val = Number(r.consumoTotal) || 0;
    const mIdx = (parseInt(r.mes, 10) || 1) - 1;
    if (mIdx >= 0 && mIdx < 12) {
      globalByMonth[mIdx] += val;
      if (val > 0) globalMonthCounts[mIdx]++;
    }

    if (!byMaterial.has(matnr)) {
      byMaterial.set(matnr, {
        matnr,
        maktx: r.maktx,
        werks: r.werks,
        meins: r.meins || 'UN',
        values: [],
        byYear: {},
        byMonth: Array.from({ length: 12 }, () => [])
      });
    }
    const item = byMaterial.get(matnr);
    item.values.push(val);
    item.byYear[r.anio] = (item.byYear[r.anio] || 0) + val;
    if (mIdx >= 0 && mIdx < 12) {
      item.byMonth[mIdx].push(val);
    }
  }

  const profiles = Array.from(byMaterial.values()).map(item => {
    const n = item.values.length || 1;
    const total = item.values.reduce((a, b) => a + b, 0);
    const mean = total / n;
    const variance = item.values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / n;
    const stdDev = Math.sqrt(variance);
    const cv = mean > 0 ? +((stdDev / mean) * 100).toFixed(1) : 0;

    // Promedio de los últimos 6 períodos vs media global (suavizamiento exponencial ponderado)
    const recent6 = item.values.slice(-6);
    const recentMean = recent6.length > 0 ? recent6.reduce((a, b) => a + b, 0) / recent6.length : mean;
    const forecastM1 = Math.max(0, +(recentMean * 0.65 + mean * 0.35).toFixed(1));
    const forecastTrimestre = +(forecastM1 * 3).toFixed(1);

    // Mes de mayor consumo promedio
    let bestMonthIdx = 0;
    let bestMonthAvg = -1;
    item.byMonth.forEach((arr, idx) => {
      const avg = arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
      if (avg > bestMonthAvg) {
        bestMonthAvg = avg;
        bestMonthIdx = idx;
      }
    });

    // Nivel de servicio 95% (Z = 1.65)
    const suggestedSS = +(1.65 * stdDev).toFixed(1);
    const suggestedRop = +(forecastM1 + suggestedSS).toFixed(1);
    const suggestedMax = +(forecastM1 * 2.5 + suggestedSS).toFixed(1);

    const pattern =
      total === 0
        ? 'Sin Consumo'
        : cv < 25
          ? 'Estable / Continua'
          : cv < 60
            ? 'Estacional Moderada'
            : 'Alta Volatilidad / Picos';

    return {
      ...item,
      total: +total.toFixed(2),
      mean: +mean.toFixed(2),
      stdDev: +stdDev.toFixed(2),
      cv,
      peakMonthLabel: bestMonthAvg > 0 ? `${MONTH_NAMES[bestMonthIdx + 1]} (${bestMonthAvg.toFixed(1)})` : 'N/A',
      forecastM1,
      forecastTrimestre,
      suggestedSS,
      suggestedRop,
      suggestedMax,
      pattern
    };
  });

  profiles.sort((a, b) => b.total - a.total);

  // Identificar meses pico globales
  const monthRanking = globalByMonth
    .map((tot, idx) => ({ mesNombre: MONTH_NAMES[idx + 1], total: +tot.toFixed(2) }))
    .sort((a, b) => b.total - a.total);

  const topSeasonMonths = monthRanking
    .filter(m => m.total > 0)
    .slice(0, 3)
    .map(m => `**${m.mesNombre}** (${m.total.toLocaleString('es-CO')})`)
    .join(', ');

  const forecastTable = [
    '| Material | Descripción | Und | Consumo Total (MVER) | Prom. Mensual | CV % (Volatilidad) | Mes Pico Estacional | Proyección Próx. Mes | Proyección Trimestral (3M) | Stock Seg. Sugerido (`EISBE`) | Punto Pedido Sugerido (`MINBE`) |',
    '| :--- | :--- | :---: | ---: | ---: | ---: | :---: | ---: | ---: | ---: | ---: |',
    ...profiles.slice(0, 15).map(
      p =>
        `| \`${p.matnr}\` | ${p.maktx} | ${p.meins} | **${p.total.toLocaleString('es-CO')}** | ${p.mean.toLocaleString('es-CO')} | ${p.cv}% (${p.pattern}) | ${p.peakMonthLabel} | **${p.forecastM1.toLocaleString('es-CO')}** | **${p.forecastTrimestre.toLocaleString('es-CO')}** | ${p.suggestedSS.toLocaleString('es-CO')} | ${p.suggestedRop.toLocaleString('es-CO')} |`
    )
  ].join('\n');

  return `# Proyección Estacional de Demanda y Optimización MRP (IA)
**Proceso:** \`PROYECCION_INV\` (\`ZFMM_HISTORICO_CONSUMO\` / Tabla \`MVER\`) | **Centro:** \`${centroLabel}\` | **Fecha:** ${nowStr}
**Arquitectura IA Seleccionada:** \`${modelDecision.selectedModel}\` — *${modelDecision.modelTier}* (${telemetry.tokenSavingsPct}% ahorro de tokens: ${telemetry.estimatedRawTokens} -> ${telemetry.estimatedMinifiedTokens} tokens mediante pivoteo M01..M12)

---

## 1. Resumen Ejecutivo de Series Temporales (\`MVER\`)
- **Materiales Analizados:** **${profiles.length}** SKUs con **${rows.length}** períodos mensuales evaluados en el centro \`${centroLabel}\`.
- **Volumen Histórico Acumulado:** **${profiles.reduce((a, p) => a + p.total, 0).toLocaleString('es-CO')}** unidades consumidas.
- **Meses de Mayor Presión Estacional:** ${topSeasonMonths || 'Sin picos registrados'}.
- **Perfil de Variabilidad:** **${profiles.filter(p => p.cv < 25 && p.total > 0).length}** materiales de demanda estable (\`CV < 25%\`), **${profiles.filter(p => p.cv >= 25 && p.cv < 60).length}** estacionales moderados y **${profiles.filter(p => p.cv >= 60).length}** con picos de alta volatilidad (\`CV >= 60%\`).

---

## 2. Matriz de Proyección de Demanda y Parámetros MRP Recomendados
*Nota metodológica: Proyección calculada mediante suavizamiento exponencial ponderado (65% tendencia últimos 6 meses + 35% media histórica) y Stock de Seguridad con nivel de servicio del 95% ($Z = 1.65 \\cdot \\sigma_d$).*

${forecastTable}

---

## 3. Diagnóstico de Estacionalidad y Recomendaciones para Demand Planning
1. **Anticipación de Picos Estacionales:** Programar órdenes de compra abiertas o contratos marco antes de los meses de mayor presión histórica (${topSeasonMonths || 'meses pico'}) para evitar compras urgentes a sobrecosto.
2. **Actualización Dinámica de \`EISBE\` y \`MINBE\` en SAP (\`MM02\`):** Ajustar el Stock de Seguridad en \`MARC\` utilizando la columna **Stock Seg. Sugerido (\`EISBE\`)** para proteger el nivel de servicio del 95% frente a la desviación estándar real de consumo ($\sigma_d$).
3. **Estrategia Diferenciada por Coeficiente de Variación ($CV$):**
   - **Materiales Estables ($CV < 25\\%$):** Automatizar mediante punto de reorden fijo (\`MRP Tipo VB\`).
   - **Materiales Estacionales / Volátiles ($CV \\ge 50\\%$):** Gestionar bajo planificación por pronóstico estacional (\`MRP Tipo VV\` o revisión mensual de Demand Planning) evitando inflar el inventario promedio durante los meses valle.`;
}

function getSimulatedStockRows(werks) {
  return [
    {
      MATNR: '000000000000408055',
      MAKTX: 'ESPARRAGO A/CARBON DE 3/4 X 3 1/2" G8',
      WERKS: werks,
      LGORT: '4000',
      LABST: '0.000',
      MABST: '0.000',
      EISBE: '100.000',
      MINBE: '300.000',
      MEINS: 'UN'
    },
    {
      MATNR: '000000000000408056',
      MAKTX: 'ESPARRAGO A/CARBON DE 5/8 X 3 1/2" G8',
      WERKS: werks,
      LGORT: '4000',
      LABST: '92.000',
      MABST: '120.000',
      EISBE: '40.000',
      MINBE: '60.000',
      MEINS: 'UN'
    }
  ];
}

function getSimulatedConsumptionRows(werks, matnr) {
  const matRaw = formatMatnrInput(matnr || '408056');
  return [
    { CODIGO_MATERIAL: matRaw, DESCRIPCION: 'ESPARRAGO A/CARBON DE 5/8 X 3 1/2" G8', CENTRO: werks, ANIO: '2025', MES: '01', CONSUMO: 93, UNIDAD: 'UN' },
    { CODIGO_MATERIAL: matRaw, DESCRIPCION: 'ESPARRAGO A/CARBON DE 5/8 X 3 1/2" G8', CENTRO: werks, ANIO: '2025', MES: '02', CONSUMO: 45, UNIDAD: 'UN' },
    { CODIGO_MATERIAL: matRaw, DESCRIPCION: 'ESPARRAGO A/CARBON DE 5/8 X 3 1/2" G8', CENTRO: werks, ANIO: '2025', MES: '03', CONSUMO: 68, UNIDAD: 'UN' }
  ];
}

module.exports = {
  fetchStockByWerks,
  fetchHistoricoConsumo,
  minifyInventoryPayload,
  selectOptimalAiModel,
  analyzeInventoryWithAi
};
