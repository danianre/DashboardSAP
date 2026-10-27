const { getSamples } = require('./st02Service');

/**
 * Análisis ejecutivo/técnico de ST02 (Tune Summary).
 *
 * Principios:
 *  - Las cifras de ST02 son ACUMULADAS desde el arranque de la instancia. Para evaluar el comportamiento
 *    reciente se usan deltas entre muestras guardadas cada 5 minutos (tabla st02_samples).
 *  - Se distingue entre dato observado, interpretación e hipótesis.
 *  - Los umbrales marcados como "operativos" son criterios de este dashboard (ajustables), no valores oficiales SAP.
 */

// Umbrales del dashboard. Las referencias SAP se indican en el texto de cada hallazgo.
const THRESHOLDS = {
  hitRatioRef: 98,          // referencia habitual en guías de tuning SAP para buffers respaldados por BD
  swapsPerDayCritical: 10000, // operativo: desplazamientos de objetos/día que justifican revisión prioritaria
  lowFreePct: 5,            // operativo: espacio o directorio prácticamente agotado
  emCurrentWarn: 80,
  emCurrentCrit: 90,
  emPeakWarn: 95,
  egWarn: 80,
  egCrit: 90,
  pageWarn: 70
};

let lastKnownWorkProcesses = [];

function setLastWorkProcesses(wps) {
  if (Array.isArray(wps) && wps.length > 0) lastKnownWorkProcesses = wps;
}

const n = (v, d = 0) => Number(v || 0).toLocaleString('es-CO', { minimumFractionDigits: d, maximumFractionDigits: d });
const pctTxt = v => (v == null ? '—' : `${n(v, 2)} %`);
const kbTxt = v => (v == null ? '—' : `${n(v)} KB`);

/**
 * Calcula deltas de swaps por buffer a partir de las muestras históricas del mismo arranque.
 */
async function computeTrends(st02) {
  const startupRaw = st02.summary.startupRaw;
  const samples = await getSamples(startupRaw, 26 * 3600000);
  const nowTs = Date.now();
  const result = { windowLabel: null, windowHours: 0, perBuffer: {}, firstSampleTs: samples[0]?.ts || null };

  if (samples.length === 0) return result;

  // Ventana preferida: la muestra más antigua dentro de las últimas 24 h (mínimo 30 min de separación)
  const candidates = samples.filter(s => nowTs - s.ts <= 24.5 * 3600000);
  const base = candidates[0];
  if (!base) return result;
  const hours = (nowTs - base.ts) / 3600000;
  if (hours < 0.5) {
    result.windowHours = Number(hours.toFixed(2));
    return result;
  }

  result.windowHours = Number(hours.toFixed(1));
  result.windowLabel = hours >= 23.5 ? 'últimas 24 h' : `últimas ${n(hours, 1)} h`;

  st02.buffers.forEach(b => {
    const prev = base.buffers?.[b.code];
    if (!prev) return;
    const dObj = b.swapObjects - Number(prev.swapObjects || 0);
    const dFrm = b.swapFrames - Number(prev.swapFrames || 0);
    const dDb = b.dbAccesses - Number(prev.dbAccesses || 0);
    if (dObj < 0 || dFrm < 0) return; // contador reiniciado
    result.perBuffer[b.code] = {
      swapObjects: dObj,
      swapFrames: dFrm,
      dbAccesses: dDb,
      swapsPerDay: Math.round((dObj / hours) * 24)
    };
  });

  return result;
}

/**
 * Tasa de swaps/día: usa la ventana reciente si cubre al menos 6 h; si no, el promedio desde el arranque.
 */
function swapRate(b, trends, uptimeDays) {
  const recent = trends.perBuffer[b.code];
  if (recent && trends.windowHours >= 6) {
    return { perDay: recent.swapsPerDay, basis: `delta real ${trends.windowLabel}`, recent: true };
  }
  if (uptimeDays && uptimeDays > 0) {
    return { perDay: Math.round(b.swapObjects / uptimeDays), basis: `promedio desde el arranque (${n(uptimeDays, 1)} días)`, recent: false };
  }
  return { perDay: null, basis: 'sin base temporal', recent: false };
}

function limitingFactor(b) {
  const lowSpace = b.pctFreeSp < THRESHOLDS.lowFreePct;
  const lowDir = b.pctFreeDir < THRESHOLDS.lowFreePct;
  if (lowSpace && lowDir) return 'espacio y directorio';
  if (lowSpace) return 'espacio';
  if (lowDir) return 'entradas de directorio';
  return null;
}

/**
 * Evaluación de buffers respaldados por base de datos (Program, CUA, Screen, Tables, Nametab).
 */
function evalDbBuffer(b, rate) {
  const hitOk = b.hitRatio >= THRESHOLDS.hitRatioRef;
  if (b.swapObjects === 0 && hitOk) return 'OK';
  if (rate.perDay != null && rate.perDay >= THRESHOLDS.swapsPerDayCritical && !hitOk) return 'CRITICAL';
  return 'WARNING';
}

function worst(statuses) {
  if (statuses.includes('CRITICAL')) return 'CRITICAL';
  if (statuses.includes('WARNING')) return 'WARNING';
  return 'OK';
}

async function buildSt02Analysis(st02, workProcesses) {
  setLastWorkProcesses(workProcesses);
  const wps = lastKnownWorkProcesses;
  const s = st02.summary;
  const uptimeDays = s.uptimeDays;
  const trends = await computeTrends(st02);
  const buf = code => st02.buffers.find(b => b.code === code);
  const mem = id => st02.memoryAreas.find(m => m.id === id);

  const indicators = [];
  const problems = [];
  const preventive = [];

  const recentTxt = (code) => {
    const r = trends.perBuffer[code];
    if (!r || !trends.windowLabel) return null;
    return `${n(r.swapObjects)} objetos desplazados en ${trends.windowLabel}`;
  };

  // ---------- 1. CUA (status GUI: menús, barras, teclas de función) ----------
  const cua = buf('CUA');
  if (cua) {
    const rate = swapRate(cua, trends, uptimeDays);
    const status = evalDbBuffer(cua, rate);
    const factor = limitingFactor(cua);
    indicators.push({
      id: 'CUA',
      nameEs: 'Buffer de menús y barras GUI',
      technical: 'CUA · rsdb/cua/buffersize',
      whatMeasures: 'Guarda en memoria los status GUI (menús, barras de herramientas, teclas de función) de las transacciones.',
      whyMatters: 'Si es insuficiente, cada pantalla vuelve a leer sus menús desde la base de datos.',
      value: `HitRatio ${pctTxt(cua.hitRatio)} · ${n(rate.perDay)} desplazamientos/día`,
      capacity: `${kbTxt(cua.allocKb)} asignados · ${pctTxt(cua.pctFreeSp)} libre · dir. ${pctTxt(cua.pctFreeDir)} libre`,
      status,
      condition: status === 'OK' ? 'Sin desplazamientos.' : `HitRatio bajo la referencia de ${THRESHOLDS.hitRatioRef} % y desplazamientos continuos (${rate.basis}).`,
      impact: 'Lecturas repetidas a BD de objetos de interfaz y mayor tiempo de respuesta al navegar.',
      action: status === 'OK' ? 'Ninguna.' : 'Revisar tamaño de rsdb/cua/buffersize frente a memoria disponible del servidor.'
    });
    if (status !== 'OK') {
      problems.push({
        id: 'CUA', status, weight: status === 'CRITICAL' ? 100 : 60,
        title: 'Buffer de menús GUI (CUA) con desplazamientos masivos y HitRatio bajo',
        observed: [
          `HitRatio ${pctTxt(cua.hitRatio)} (referencia habitual ≥ ${THRESHOLDS.hitRatioRef} %).`,
          `Swaps en ST02: ${n(cua.swaps)} (frames) · ${n(cua.swapObjects)} objetos desplazados desde el arranque.`,
          `Ritmo: ${n(rate.perDay)} objetos desplazados/día (${rate.basis}).`,
          recentTxt('CUA'),
          `${n(cua.dbAccesses)} accesos a BD originados por este buffer.`,
          `Tamaño asignado: ${kbTxt(cua.allocKb)}. Directorio: ${n(cua.actObjects)} de ${n(cua.dirSize)} entradas en uso (${pctTxt(cua.pctFreeDir)} libre).`
        ].filter(Boolean),
        interpretation: factor === 'entradas de directorio'
          ? 'El limitante es el número de entradas de directorio.'
          : 'El directorio tiene entradas libres, por lo que el limitante es el espacio en memoria del buffer: los objetos se desplazan para hacer sitio a otros.',
        hypothesis: 'El tamaño asignado (3.000 KB) corresponde a un valor pequeño para la cantidad de status GUI usados en un ECC productivo; confirmar con el valor de RZ11 y el historial de cambios del perfil.',
        impact: 'Más lecturas a la base de datos y pantallas más lentas al cargar menús. No provoca caídas, pero degrada el tiempo de respuesta de diálogo de forma constante.',
        checks: [
          'RZ11 → rsdb/cua/buffersize: confirmar valor actual y por defecto.',
          'ST06 / OS: verificar memoria física libre antes de proponer un aumento.',
          'ST03N: comparar tiempos de respuesta de diálogo con la línea base.',
          'Si se aprueba el ajuste: cambiar en RZ10 (perfil de instancia) y planificar reinicio; validar después que los swaps diarios bajen.'
        ]
      });
    }
  }

  // ---------- 2. Screen (Dynpros) ----------
  const pres = buf('PRES');
  if (pres) {
    const rate = swapRate(pres, trends, uptimeDays);
    const status = evalDbBuffer(pres, rate);
    const factor = limitingFactor(pres);
    indicators.push({
      id: 'PRES',
      nameEs: 'Buffer de pantallas (Dynpros)',
      technical: 'Screen · zcsa/presentation_buffer_area · sap/bufdir_entries',
      whatMeasures: 'Guarda las pantallas generadas de las transacciones.',
      whyMatters: 'Si es insuficiente, las pantallas se vuelven a cargar desde la BD.',
      value: `HitRatio ${pctTxt(pres.hitRatio)} · ${n(rate.perDay)} desplazamientos/día`,
      capacity: `${kbTxt(pres.allocKb)} asignados · ${pctTxt(pres.pctFreeSp)} libre · dir. ${pctTxt(pres.pctFreeDir)} libre`,
      status,
      condition: status === 'OK' ? 'Sin desplazamientos.' : `Desplazamientos continuos con espacio libre ${pctTxt(pres.pctFreeSp)} (${rate.basis}).`,
      impact: 'Carga repetida de pantallas desde BD y mayor tiempo de respuesta.',
      action: status === 'OK' ? 'Ninguna.' : 'Evaluar zcsa/presentation_buffer_area junto con CUA (mismo patrón).'
    });
    if (status !== 'OK') {
      problems.push({
        id: 'PRES', status, weight: status === 'CRITICAL' ? 95 : 55,
        title: 'Buffer de pantallas (Screen) sin espacio libre y con desplazamientos',
        observed: [
          `HitRatio ${pctTxt(pres.hitRatio)} (referencia habitual ≥ ${THRESHOLDS.hitRatioRef} %).`,
          `${n(pres.swapObjects)} swaps desde el arranque · ${n(rate.perDay)}/día (${rate.basis}).`,
          recentTxt('PRES'),
          `Espacio libre: ${kbTxt(pres.freeKb)} de ${kbTxt(pres.availKb)} (${pctTxt(pres.pctFreeSp)}). Directorio ${pctTxt(pres.pctFreeDir)} libre.`,
          `${n(pres.dbAccesses)} accesos a BD originados por este buffer.`
        ].filter(Boolean),
        interpretation: factor === 'espacio'
          ? 'El espacio del buffer está agotado mientras el directorio tiene entradas libres: el limitante es el tamaño (zcsa/presentation_buffer_area), no sap/bufdir_entries.'
          : 'Desplazamientos presentes; revisar si el limitante es el tamaño o las entradas de directorio.',
        hypothesis: null,
        impact: 'Degradación moderada del tiempo de respuesta al abrir pantallas. Menor que CUA por volumen, pero con la misma causa probable.',
        checks: [
          'RZ11 → zcsa/presentation_buffer_area y sap/bufdir_entries.',
          'Analizar el ajuste conjuntamente con CUA para un único cambio de perfil y un único reinicio.'
        ]
      });
    }
  }

  // ---------- 3. Program (cargas ABAP) ----------
  const pxa = buf('PXA');
  if (pxa) {
    const rate = swapRate(pxa, trends, uptimeDays);
    const status = evalDbBuffer(pxa, rate);
    indicators.push({
      id: 'PXA',
      nameEs: 'Buffer de programas ABAP',
      technical: 'Program (PXA) · abap/buffersize',
      whatMeasures: 'Guarda los programas ABAP compilados (cargas) que ejecutan los usuarios y jobs.',
      whyMatters: 'Es el buffer más grande y crítico; si desplaza mucho, los programas se recargan desde la BD.',
      value: `HitRatio ${pctTxt(pxa.hitRatio)} · ${n(rate.perDay)} desplazamientos/día`,
      capacity: `${kbTxt(pxa.allocKb)} asignados · ${pctTxt(pxa.pctFreeSp)} libre`,
      status,
      condition: status === 'OK'
        ? 'Sin desplazamientos.'
        : `HitRatio adecuado; desplazamientos bajos en proporción a ${n(pxa.requests)} solicitudes. Espacio lleno (comportamiento esperado: el buffer se llena y desplaza lo menos usado).`,
      impact: 'Bajo con los valores actuales. Sería relevante si los desplazamientos crecen o el HitRatio baja de la referencia.',
      action: status === 'OK' ? 'Ninguna.' : 'Seguimiento de tendencia; no se justifica cambiar abap/buffersize con estos datos.'
    });
    if (status !== 'OK') {
      problems.push({
        id: 'PXA', status, weight: 30,
        title: 'Buffer de programas lleno con desplazamientos moderados (seguimiento)',
        observed: [
          `HitRatio ${pctTxt(pxa.hitRatio)} (≥ ${THRESHOLDS.hitRatioRef} %).`,
          `${n(pxa.swapObjects)} swaps desde el arranque · ${n(rate.perDay)}/día (${rate.basis}).`,
          recentTxt('PXA'),
          `Espacio libre ${pctTxt(pxa.pctFreeSp)}; directorio ${pctTxt(pxa.pctFreeDir)} libre.`
        ].filter(Boolean),
        interpretation: 'ST02 lo resalta por tener swaps, pero la proporción de desplazamientos frente a solicitudes es muy baja y el HitRatio está en rango. Un buffer de programas lleno es normal.',
        hypothesis: null,
        impact: 'Bajo en la situación actual.',
        checks: [
          'Vigilar que el ritmo diario de desplazamientos no aumente tras transportes o picos de cierre.',
          'Revisar si coinciden picos de desplazamiento con importaciones de transportes (STMS).'
        ]
      });
    }
  }

  // ---------- 4. Export/import (datos compartidos de aplicaciones) ----------
  const eibuf = buf('EIBUF');
  if (eibuf) {
    const recent = trends.perBuffer.EIBUF;
    const rate = swapRate(eibuf, trends, uptimeDays);
    const noRecentSwaps = recent && trends.windowHours >= 6 && recent.swapObjects === 0;
    const status = eibuf.swapObjects === 0 || noRecentSwaps ? 'OK' : 'WARNING';
    indicators.push({
      id: 'EIBUF',
      nameEs: 'Buffer de datos compartidos (Export/Import)',
      technical: 'Export/import (EIBUF) · rsdb/obj/buffersize · rsdb/obj/max_objects',
      whatMeasures: 'Datos que los programas guardan temporalmente para compartirlos (EXPORT … TO SHARED BUFFER).',
      whyMatters: 'Si desplaza objetos, las aplicaciones deben recalcular o volver a leer esos datos.',
      value: `${n(rate.perDay)} desplazamientos/día · HitRatio ${pctTxt(eibuf.hitRatio)} (no aplica como criterio)`,
      capacity: `${pctTxt(eibuf.pctFreeSp)} espacio libre · dir. ${n(eibuf.actObjects)}/${n(eibuf.dirSize)} (${pctTxt(eibuf.pctFreeDir)} libre)`,
      status,
      condition: noRecentSwaps
        ? `Sin desplazamientos en ${trends.windowLabel}.`
        : `Desplazamientos con espacio libre suficiente: el limitante probable son las entradas de directorio en picos.`,
      impact: 'No genera accesos directos a BD (DB Accs = 0); impacto en programas que reutilizan esos datos.',
      action: status === 'OK' ? 'Ninguna.' : 'Medir uso de directorio en horas pico antes de ajustar rsdb/obj/max_objects.'
    });
    if (status !== 'OK') {
      problems.push({
        id: 'EIBUF', status, weight: 40,
        title: 'Buffer Export/Import desplaza objetos aunque tiene espacio libre',
        observed: [
          `Swaps en ST02: ${n(eibuf.swaps)} (frames) · ${n(eibuf.swapObjects)} objetos desplazados desde el arranque (${n(rate.perDay)}/día, ${rate.basis}).`,
          recentTxt('EIBUF'),
          `Espacio libre ${pctTxt(eibuf.pctFreeSp)}. Directorio actual: ${n(eibuf.actObjects)} de ${n(eibuf.dirSize)} entradas (${pctTxt(eibuf.pctFreeDir)} libre).`,
          `HitRatio ${pctTxt(eibuf.hitRatio)}: el ${pctTxt(eibuf.notFoundPct)} de las solicitudes son consultas de objetos inexistentes.`
        ].filter(Boolean),
        interpretation: 'El HitRatio bajo NO indica un problema: casi todas las solicitudes buscan datos que la aplicación aún no ha guardado (comportamiento normal de este buffer). Lo relevante son los desplazamientos, que ocurren con espacio libre disponible.',
        hypothesis: 'El directorio (rsdb/obj/max_objects) se satura en momentos de alta carga y provoca desplazamientos, aunque en la consulta actual tenga entradas libres. Requiere medir en horas pico para confirmarlo.',
        impact: 'Moderado y localizado: programas que reutilizan datos compartidos deben recalcularlos. Sin impacto directo en la BD.',
        checks: [
          'Revisar en ST02 (doble clic en Export/import) el uso de directorio durante horas pico y cierres.',
          'Comparar el delta de desplazamientos de las próximas 24 h en este dashboard antes de proponer cambios.',
          'RZ11 → rsdb/obj/max_objects y rsdb/obj/buffersize.'
        ]
      });
    }
  }

  // ---------- 5. Tables buffer ----------
  const tabl = buf('TABL');
  if (tabl) {
    const rate = swapRate(tabl, trends, uptimeDays);
    const status = evalDbBuffer(tabl, rate);
    indicators.push({
      id: 'TABL',
      nameEs: 'Buffer de tablas',
      technical: 'Tables Buffer (TABL) · zcsa/table_buffer_area · zcsa/db_max_buftab',
      whatMeasures: 'Copia en memoria de tablas configuradas como "bufferizadas" (parametrización, maestros pequeños).',
      whyMatters: 'Evita lecturas a BD en tablas muy consultadas; si falla, aumenta la carga de la BD.',
      value: `HitRatio ${pctTxt(tabl.hitRatio)} · ${n(tabl.swapObjects)} swaps`,
      capacity: `${pctTxt(tabl.pctFreeSp)} espacio libre · dir. ${pctTxt(tabl.pctFreeDir)} libre`,
      status,
      condition: status === 'OK' ? 'HitRatio alto, sin desplazamientos y con holgura de espacio y directorio.' : 'Presenta desplazamientos o HitRatio bajo.',
      impact: status === 'OK' ? 'Ninguno actualmente.' : 'Aumento de lecturas a BD.',
      action: status === 'OK' ? 'Seguimiento preventivo.' : 'Revisar ST10 (estadística de tablas bufferizadas).'
    });
    if (status === 'OK') {
      preventive.push({
        nameEs: 'Buffer de tablas', technical: 'Tables Buffer', value: `${pctTxt(tabl.pctFreeSp)} libre · ${pctTxt(tabl.pctFreeDir)} dir. libre`,
        watch: `Alertar si aparecen swaps o el espacio/directorio libre baja de ${THRESHOLDS.lowFreePct} %.`,
        why: 'Es el buffer que más lecturas a BD evita; un crecimiento de tablas bufferizadas puede agotarlo.'
      });
    }
  }

  // ---------- 6. Nametab (diccionario) ----------
  const ntab = ['TTAB', 'FTAB', 'SNTAB', 'IRBD'].map(buf).filter(Boolean);
  if (ntab.length) {
    const statuses = ntab.map(b => evalDbBuffer(b, swapRate(b, trends, uptimeDays)));
    const status = worst(statuses);
    const minHit = ntab.reduce((m, b) => (b.hitRatio < m.hitRatio ? b : m), ntab[0]);
    const swaps = ntab.reduce((a, b) => a + b.swapObjects, 0);
    indicators.push({
      id: 'NTAB',
      nameEs: 'Buffers del diccionario ABAP',
      technical: 'Nametab (NTAB): Table definition, Field definition, Short NTAB, Initial records',
      whatMeasures: 'Definiciones de tablas y campos que el sistema consulta en cada acceso a datos.',
      whyMatters: 'Un fallo aquí afecta a todas las transacciones.',
      value: `HitRatio mínimo ${pctTxt(minHit.hitRatio)} (${minHit.label}) · ${n(swaps)} swaps`,
      capacity: null,
      status,
      condition: status === 'OK' ? 'Todos sin desplazamientos y con HitRatio en rango.' : 'Algún buffer del diccionario presenta desplazamientos.',
      impact: status === 'OK' ? 'Ninguno actualmente.' : 'Lecturas adicionales al diccionario en BD.',
      action: status === 'OK' ? 'Seguimiento preventivo.' : 'Revisar parámetros rsdb/ntab/*.'
    });
    if (status === 'OK') {
      preventive.push({
        nameEs: 'Diccionario ABAP (Nametab)', technical: 'TTAB / FTAB / SNTAB / IRBD', value: `HitRatio mín. ${pctTxt(minHit.hitRatio)}`,
        watch: 'Alertar ante cualquier swap. Revisar después de grandes transportes o activaciones de diccionario.',
        why: 'Afecta a todo el sistema; hoy está sano pero es sensible a cambios masivos del diccionario.'
      });
    }
  }

  // ---------- 7. Memoria extendida ----------
  const em = mem('EXTENDED_MEMORY');
  const heap = mem('HEAP_MEMORY');
  if (em) {
    let status = 'OK';
    if (em.currUsePct >= THRESHOLDS.emCurrentCrit) status = 'CRITICAL';
    else if (em.currUsePct >= THRESHOLDS.emCurrentWarn || em.maxUsePct >= THRESHOLDS.emPeakWarn) status = 'WARNING';
    indicators.push({
      id: 'EM',
      nameEs: 'Memoria extendida (uso actual y pico)',
      technical: 'Extended memory · em/initial_size_MB',
      whatMeasures: 'Memoria principal donde trabajan las sesiones de usuario.',
      whyMatters: 'Si se agota, los procesos de diálogo pasan a modo PRIV (quedan reservados para un solo usuario).',
      value: `Actual ${pctTxt(em.currUsePct)} · Pico ${pctTxt(em.maxUsePct)}`,
      capacity: `${kbTxt(em.inMemKb)} configurados`,
      status,
      condition: em.currUsePct < THRESHOLDS.emCurrentWarn && em.maxUsePct >= THRESHOLDS.emPeakWarn
        ? 'Uso actual holgado, pero el pico desde el arranque llegó casi al límite.'
        : (status === 'OK' ? 'Uso actual y pico con holgura.' : 'Uso actual elevado.'),
      impact: 'En un pico similar, nuevas sesiones pueden quedar en modo PRIV o fallar por falta de memoria.',
      action: status === 'OK' ? 'Ninguna.' : 'Identificar cuándo ocurrió el pico (ST22, SM37, ST03N) antes de modificar memoria.'
    });

    if (status !== 'OK') {
      const heapLimitKb = heap ? Math.round((heap.heapAreaDiaBytes + heap.heapAreaNonDiaBytes) / 1024) : 0;
      const heapPeakPct = heap && heapLimitKb > 0 ? (heap.maxUseKb / heapLimitKb) * 100 : null;
      problems.push({
        id: 'EM', status, weight: status === 'CRITICAL' ? 98 : 70, pendingValidation: em.currUsePct < THRESHOLDS.emCurrentWarn,
        title: em.currUsePct < THRESHOLDS.emCurrentWarn
          ? 'Pico histórico de memoria extendida cercano al límite (por validar)'
          : 'Uso actual elevado de memoria extendida',
        observed: [
          `Uso actual: ${kbTxt(em.curUseKb)} de ${kbTxt(em.inMemKb)} (${pctTxt(em.currUsePct)}).`,
          `Uso máximo desde el arranque (${s.startupFormatted}): ${kbTxt(em.maxUseKb)} (${pctTxt(em.maxUsePct)}).`,
          heap && heapPeakPct != null
            ? `Heap: uso máximo reportado ${kbTxt(heap.maxUseKb)} ≈ ${n(heapPeakPct, 1)} % de abap/heap_area_dia + abap/heap_area_nondia (${n(heapLimitKb)} KB).`
            : null
        ].filter(Boolean),
        interpretation: 'El dato de pico es acumulado: ST02 no indica cuándo ocurrió ni cuánto duró. El uso actual es normal.',
        hypothesis: 'Hubo al menos un evento de alta demanda de memoria (por ejemplo, un reporte o job con gran volumen) que llevó la memoria extendida casi al límite y forzó uso intensivo de heap. Parte del heap puede deberse a procesos de fondo, que por diseño usan heap primero.',
        impact: 'Si el evento se repite en horario de usuarios, pueden aparecer procesos de diálogo en modo PRIV, lentitud generalizada o dumps por memoria.',
        checks: [
          'ST22: buscar dumps TSV_TNEW_PAGE_ALLOC_FAILED, SYSTEM_NO_ROLL o MEMORY_NO_MORE_PAGING desde el arranque.',
          'RZ11 → abap/heap_area_total y em/initial_size_MB: confirmar límites reales.',
          'ST06: memoria física y swap del sistema operativo.',
          'SM37 / ST03N: identificar jobs o transacciones con mayor consumo de memoria.',
          'No aumentar em/initial_size_MB sin validar la memoria física disponible del servidor.'
        ]
      });
    }
  }

  // ---------- 8. Procesos de diálogo en modo PRIV ----------
  const wpTypeOf = wpNo => {
    const wp = wps.find(w => Number(w.wp_no) === Number(wpNo));
    return wp ? String(wp.wp_typ || '').toUpperCase() : null;
  };
  const priv = (st02.privContexts || []).map(p => ({ ...p, type: wpTypeOf(p.wpNo) }));
  const privDia = priv.filter(p => p.type === 'DIA');
  const privUnknown = priv.filter(p => !p.type);
  const privNonDia = priv.filter(p => p.type && p.type !== 'DIA');
  const diaTotal = wps.filter(w => String(w.wp_typ).toUpperCase() === 'DIA').length;
  {
    const status = privDia.length > 0 ? 'WARNING' : 'OK';
    indicators.push({
      id: 'PRIV',
      nameEs: 'Procesos de diálogo en modo PRIV',
      technical: 'Heap memory · modo PRIV · abap/heap_area_dia',
      whatMeasures: 'Procesos de diálogo que agotaron su memoria extendida y quedaron reservados para un solo usuario.',
      whyMatters: 'Cada proceso en PRIV deja de atender a los demás usuarios hasta que termina la transacción.',
      value: `${privDia.length} de ${diaTotal || '—'} procesos DIA` + (privNonDia.length ? ` · ${privNonDia.length} de fondo usando heap` : ''),
      capacity: null,
      status,
      condition: privDia.length > 0
        ? `En PRIV: ${privDia.map(p => `WP ${p.wpNo} (${p.user}${p.privSince ? `, desde ${p.privSince.slice(0, 2)}:${p.privSince.slice(2, 4)}` : ''})`).join(', ')}.`
        : (privNonDia.length
          ? 'Ningún proceso de diálogo en PRIV. Los procesos de fondo usan heap primero por diseño (normal).'
          : 'Ningún proceso en modo PRIV.'),
      impact: 'Reduce la capacidad de atención de usuarios simultáneos.',
      action: privDia.length > 0 ? 'Revisar en SM50/SM04 la transacción del usuario; contactarlo si se prolonga.' : 'Ninguna.'
    });
    if (privUnknown.length > 0) {
      preventive.push({
        nameEs: 'Procesos con heap sin clasificar', technical: 'EXTENDED_MEMORY_ACTIVE_CONTEXT',
        value: `${privUnknown.length} proceso(s): ${privUnknown.map(p => `WP ${p.wpNo}`).join(', ')}`,
        watch: 'Validar en SM50 si son de diálogo o de fondo.',
        why: 'Solo los procesos de diálogo en PRIV afectan la capacidad de atención a usuarios.'
      });
    }
    if (status !== 'OK') {
      problems.push({
        id: 'PRIV', status, weight: 65,
        title: `${privDia.length} proceso(s) de diálogo en modo PRIV`,
        observed: privDia.map(p => `WP ${p.wpNo} · usuario ${p.user} · heap ${kbTxt(p.privKb)}${p.privSince ? ` · desde ${p.privSince.slice(0, 2)}:${p.privSince.slice(2, 4)}:${p.privSince.slice(4, 6)}` : ''}`),
        interpretation: 'El proceso consumió su cuota de memoria extendida y está reservado para ese usuario hasta terminar la transacción.',
        hypothesis: 'Transacción o reporte con gran volumen de datos en diálogo.',
        impact: `Se reduce la capacidad disponible de procesos de diálogo (${privDia.length} de ${diaTotal || '—'}).`,
        checks: [
          'SM50 / SM04: identificar transacción y programa del usuario.',
          'Si la situación se prolonga, coordinar con el usuario antes de cancelar la sesión.',
          'Recomendar ejecución en fondo para reportes de gran volumen.'
        ]
      });
    }
  }

  // ---------- 9. Memoria global extendida ----------
  const eg = mem('EXT_GLOBAL_MEMORY');
  if (eg) {
    let status = 'OK';
    if (eg.currUsePct >= THRESHOLDS.egCrit) status = 'CRITICAL';
    else if (eg.currUsePct >= THRESHOLDS.egWarn) status = 'WARNING';
    indicators.push({
      id: 'EG',
      nameEs: 'Memoria global extendida',
      technical: 'Ext. global memory · em/global_area_MB',
      whatMeasures: 'Memoria compartida por todos los procesos para objetos y datos globales.',
      whyMatters: 'Si se agota, fallan las aplicaciones que dependen de memoria compartida.',
      value: `Actual ${pctTxt(eg.currUsePct)} · Pico ${pctTxt(eg.maxUsePct)}`,
      capacity: `${kbTxt(eg.inMemKb)} configurados`,
      status,
      condition: status === 'OK' ? 'Uso estable; el pico apenas supera el valor actual.' : 'Uso elevado.',
      impact: status === 'OK' ? 'Ninguno actualmente.' : 'Riesgo de errores en aplicaciones que usan memoria compartida.',
      action: status === 'OK' ? 'Seguimiento preventivo.' : 'Revisar consumidores en SHMM y em/global_area_MB.'
    });
    if (status === 'OK') {
      preventive.push({
        nameEs: 'Memoria global extendida', technical: 'Ext. global memory', value: `${pctTxt(eg.currUsePct)} (pico ${pctTxt(eg.maxUsePct)})`,
        watch: `Umbral operativo: advertencia ≥ ${THRESHOLDS.egWarn} %, crítico ≥ ${THRESHOLDS.egCrit} %.`,
        why: 'Es el área de memoria con mayor ocupación sostenida; tiene poco margen de crecimiento.'
      });
    }
  }

  // ---------- 10. Área de paginación ----------
  const page = mem('PAGE_AREA');
  if (page) {
    const status = page.currUsePct >= THRESHOLDS.pageWarn ? 'WARNING' : 'OK';
    const peakOnDisk = page.maxUseKb > page.inMemKb;
    indicators.push({
      id: 'PAGE',
      nameEs: 'Área de paginación SAP',
      technical: 'Page area · rdisp/PG_SHM · rdisp/PG_MAXFS',
      whatMeasures: 'Memoria para datos temporales de programas (por ejemplo, EXPORT TO MEMORY).',
      whyMatters: 'Si se agota, los programas terminan con error; si supera la parte en memoria, usa disco y es más lenta.',
      value: `Actual ${pctTxt(page.currUsePct)} · Pico ${pctTxt(page.maxUsePct)}`,
      capacity: `${kbTxt(page.totalKb)} totales (${kbTxt(page.inMemKb)} en memoria)`,
      status,
      condition: status === 'OK'
        ? (peakOnDisk ? 'Uso actual bajo; en el pico se utilizó la parte en disco.' : 'Uso bajo.')
        : 'Uso elevado.',
      impact: status === 'OK' ? 'Ninguno actualmente.' : 'Riesgo de dumps por falta de área de paginación.',
      action: status === 'OK' ? 'Seguimiento preventivo.' : 'Revisar programas con alto uso de memoria temporal.'
    });
    if (status === 'OK') {
      preventive.push({
        nameEs: 'Área de paginación SAP', technical: 'Page area', value: `${pctTxt(page.currUsePct)} (pico ${pctTxt(page.maxUsePct)})`,
        watch: `Advertencia operativa ≥ ${THRESHOLDS.pageWarn} %. ${peakOnDisk ? `El pico (${kbTxt(page.maxUseKb)}) superó la parte en memoria (${kbTxt(page.inMemKb)}).` : ''}`,
        why: 'Un pico que supera la parte en memoria implica uso de disco y lentitud puntual.'
      });
    }
  }

  // ---------- Indicadores preventivos sin umbral SAP universal ----------
  preventive.push({
    nameEs: 'Caché de sentencias SQL',
    technical: 'SAPCurCach · Statement / IDs',
    value: `Sentencias ${pctTxt(s.cursorCacheStmtHitRatio)} · IDs ${pctTxt(s.cursorCacheIdHitRatio)}`,
    watch: 'Sin umbral SAP universal: usar el valor actual como línea base y vigilar caídas sostenidas.',
    why: 'Una caída indica más re-preparación de sentencias SQL y mayor carga en la base de datos.'
  });
  preventive.push({
    nameEs: 'Eficiencia de lecturas de tablas',
    technical: 'Select single / Select / Total HitRatio',
    value: `Select single ${pctTxt(s.dbDirectHitRatio)} · Select ${pctTxt(s.dbSequentialHitRatio)} · Total ${pctTxt(s.dbAverageHitRatio)}`,
    watch: 'Línea base. Depende del tipo de aplicaciones; no compararlo con otros sistemas.',
    why: 'Una caída sostenida puede reflejar cambios de programas o de bufferización de tablas.'
  });

  // ---------- Resumen ----------
  problems.sort((a, b) => b.weight - a.weight);
  const criticalCount = indicators.filter(i => i.status === 'CRITICAL').length;
  const warningCount = indicators.filter(i => i.status === 'WARNING').length;
  const overallStatus = criticalCount > 0 ? 'CRITICAL' : warningCount > 0 ? 'WARNING' : 'OK';
  const top = problems[0];

  const dataGaps = [];
  if (!trends.windowLabel || trends.windowHours < 6) {
    dataGaps.push(`Tendencia real de swaps: el dashboard guarda muestras cada 5 min desde ${trends.firstSampleTs ? new Date(trends.firstSampleTs).toLocaleString('es-CO') : 'ahora'}; se necesitan ≥ 6 h para usar deltas en lugar del promedio desde el arranque.`);
  }
  dataGaps.push('Valores actuales de parámetros de perfil (RZ11) para confirmar tamaños y límites.');
  dataGaps.push('Memoria física y uso de swap del sistema operativo (ST06) antes de proponer aumentos.');
  dataGaps.push('Dumps de memoria en ST22 y tiempos de respuesta en ST03N para correlacionar impacto real.');
  if (st02.source !== 'SAP_RFC_SAPTUNE_GET_SUMMARY_STATISTIC') {
    dataGaps.unshift('Los datos mostrados son de respaldo (SAP no disponible): no usar para diagnóstico.');
  }

  return {
    thresholds: THRESHOLDS,
    trends: { windowLabel: trends.windowLabel, windowHours: trends.windowHours, firstSampleTs: trends.firstSampleTs },
    overall: {
      status: overallStatus,
      criticalCount,
      warningCount,
      normalCount: indicators.length - criticalCount - warningCount,
      mainRisk: top ? top.title : 'Sin riesgos relevantes detectados.',
      priorityAction: top ? top.checks[0] : 'Mantener el seguimiento preventivo.',
      uptimeDays,
      isFallback: st02.source !== 'SAP_RFC_SAPTUNE_GET_SUMMARY_STATISTIC'
    },
    indicators,
    problems,
    preventive,
    dataGaps
  };
}

module.exports = {
  buildSt02Analysis,
  setLastWorkProcesses
};
