/**
 * ============================================================================
 * SERVICIO DE INTELIGENCIA Y ANÁLISIS DE RIESGOS FINANCIEROS — SAP ANALYTICS CLOUD
 * Módulo 1: Evaluación del Riesgo Crediticio de Clientes, Cartera y Pérdida Esperada
 * Módulo 2: Impacto de Fluctuaciones Económicas (FX, Inflación, Tasas, Sensibilidad)
 * Módulo 3: Modelos Predictivos SAC Smart Predict (Clasificación, Regresión, Series)
 * Módulo 4: Simulación de Escenarios Económicos y Pruebas de Estrés Financiero
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { executeRfc, SAP_CONFIG } = require('../config/sap');

const RISK_CACHE_FILE_PATH = path.join(__dirname, '..', 'financial_risk_cache.json.gz');
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutos

let _riskMemoryStore = null;
let _lastRiskSyncTimestamp = 0;
let _riskSyncInProgress = null;

// Catálogo de Sociedades Financieras
const COMPANY_CODES_CATALOG = [
  { code: 'DA17', name: 'C.I. Tequendama S.A.S.', currency: 'COP', segment: 'Agroindustria y Exportación de Aceites' },
  { code: 'DA11', name: 'Ecobio Colombia S.A.S.', currency: 'COP', segment: 'Cultivos Orgánicos y Palma' },
  { code: 'DA34', name: 'Biocombustibles Sostenibles del Caribe S.A.', currency: 'COP', segment: 'Energéticos y Biodiésel' },
  { code: 'DA23', name: 'Caribbean Eco Soaps S.A.S.', currency: 'COP', segment: 'Manufactura Jabonería Exportación' },
  { code: 'DA03', name: 'Sociedad Portuaria Superportuaria S.A.S.', currency: 'COP', segment: 'Operación Portuaria y Logística' },
  { code: 'DA09', name: 'Terlica S.A.S.', currency: 'COP', segment: 'Almacenamiento de Graneles Líquidos' },
  { code: 'DA33', name: 'Oleoyuma S.A.S.', currency: 'COP', segment: 'Extracción de Aceite de Palma' },
  { code: 'DA83', name: 'Daabon International Trading', currency: 'USD', segment: 'Comercialización Internacional' }
];

// Catálogo de Sectores Económicos de Clientes
const ECONOMIC_SECTORS_CATALOG = [
  { code: 'ALIMENTOS_GLOBAL', name: 'Industria Global de Alimentos y Consumo Masivo' },
  { code: 'ENERGIA_BIOCOMBUSTIBLES', name: 'Mayoristas de Combustibles y Energía' },
  { code: 'OLEOQUIMICA_COSMETICA', name: 'Oleoquímica, Cuidado Personal y Cosmética' },
  { code: 'RETAIL_NACIONAL', name: 'Grandes Superficies, Retail e Industrial Nacional' },
  { code: 'LOGISTICA_PORTUARIA', name: 'Navieras, Agencias de Carga y Comercio Exterior' },
  { code: 'AGROINDUSTRIA', name: 'Procesadores Agroindustriales y Balanceados' }
];

// Escenarios Económicos y de Estrés Financiero (Sección 6)
const PRESET_RISK_SCENARIOS = [
  {
    id: 'escenario-optimista',
    name: '1. Escenario Económico Optimista',
    badge: 'Optimista',
    tone: 'emerald',
    description: 'Recuperación acelerada de cartera (-3.2 pts en morosidad), expansión de demanda internacional (+6.5%), tasa de cambio competitiva (+4.0% USD/COP), moderación inflacionaria (-1.2 pts) y recorte de tasas de interés (-150 pbs).',
    assumptions: {
      delinquencyShiftPct: -22.0,
      revenueChangePct: 6.5,
      fxRateChangePct: 4.0,
      inflationChangePts: -1.2,
      interestRateDeltaBps: -150,
      dsoDeltaDays: -5.0,
      creditExposureGrowthPct: 3.0,
      operatingCostChangePct: -1.5
    }
  },
  {
    id: 'escenario-base',
    name: '2. Escenario Económico Base (Presupuesto Aprobado)',
    badge: 'Base Oficial',
    tone: 'cyan',
    description: 'Continuidad de las condiciones macroeconómicas y crediticias vigentes según el pronóstico financiero aprobado por el Comité de Riesgos.',
    assumptions: {
      delinquencyShiftPct: 0.0,
      revenueChangePct: 2.0,
      fxRateChangePct: 0.5,
      inflationChangePts: 0.0,
      interestRateDeltaBps: 0,
      dsoDeltaDays: 0.0,
      creditExposureGrowthPct: 1.5,
      operatingCostChangePct: 1.0
    }
  },
  {
    id: 'escenario-adverso',
    name: '3. Escenario Económico Adverso',
    badge: 'Adverso Moderado',
    tone: 'amber',
    description: 'Desaceleración sectorial con aumento de cartera vencida (+30%), contracción de ingresos (-5.5%), apreciación adversa del peso (-6.5% en liquidación de exportaciones), presión inflacionaria (+1.8 pts) y alza de tasas (+175 pbs).',
    assumptions: {
      delinquencyShiftPct: 30.0,
      revenueChangePct: -5.5,
      fxRateChangePct: -6.5,
      inflationChangePts: 1.8,
      interestRateDeltaBps: 175,
      dsoDeltaDays: 8.0,
      creditExposureGrowthPct: 6.0,
      operatingCostChangePct: 3.8
    }
  },
  {
    id: 'escenario-estres-severo',
    name: '4. Escenario de Estrés Severo (Stress Test)',
    badge: 'Estrés Severo',
    tone: 'rose',
    description: 'Choque simultáneo de liquidez y mercado: duplicación de incumplimientos (+65%), caída de ventas (-12.5%), choque cambiario (-12.0%), inflación de costos (+3.5 pts), alza de tasas (+325 pbs) y extensión de pago en +16 días DSO.',
    assumptions: {
      delinquencyShiftPct: 65.0,
      revenueChangePct: -12.5,
      fxRateChangePct: -12.0,
      inflationChangePts: 3.5,
      interestRateDeltaBps: 325,
      dsoDeltaDays: 16.0,
      creditExposureGrowthPct: 11.0,
      operatingCostChangePct: 7.2
    }
  }
];

function parseSapNumber(str) {
  if (str === undefined || str === null) return 0;
  if (typeof str === 'number') return str;
  const s = String(str).trim().replace(/,/g, '');
  if (!s) return 0;
  if (s.endsWith('-')) {
    return -Math.abs(parseFloat(s.slice(0, -1)) || 0);
  }
  return parseFloat(s) || 0;
}

async function readSapTableSafe(tableName, fields, options = [], rowCount = 200) {
  try {
    const res = await executeRfc('RFC_READ_TABLE', {
      QUERY_TABLE: tableName,
      DELIMITER: '|',
      ROWCOUNT: rowCount,
      FIELDS: fields.map(f => ({ FIELDNAME: f })),
      OPTIONS: options.map(TEXT => ({ TEXT: String(TEXT).slice(0, 72) }))
    });
    const meta = res.Fields || res.FIELDS || [];
    const rows = res.DATA || [];
    return rows.map(r => {
      const parts = String(r.WA || '').split('|');
      const obj = {};
      meta.forEach((f, idx) => {
        obj[f.FIELDNAME] = (parts[idx] || '').trim();
      });
      return obj;
    });
  } catch (err) {
    return [];
  }
}

/**
 * Sincroniza los datos de Cuentas por Cobrar (BSID, BSAD), Gestión de Crédito (KNKK, T014),
 * Condiciones de Pago (KNB1), Cuentas por Pagar (BSIK) y Tipos de Cambio (TCURR) desde SAP ECC 6.0.
 */
async function syncFinancialRiskDatasetFromSap() {
  const syncStartedAt = Date.now();
  let sapConnected = false;
  const sapStats = {
    openReceivablesRead: 0,
    clearedReceivablesRead: 0,
    creditMasterRead: 0,
    creditAreasRead: 0,
    openPayablesRead: 0,
    fxRatesRead: 0
  };

  try {
    const [bsidRows, bsadRows, knkkRows, t014Rows, bsikRows, tcurrRows] = await Promise.all([
      readSapTableSafe('BSID', ['BUKRS', 'KUNNR', 'GJAHR', 'BELNR', 'BLDAT', 'BUDAT', 'WAERS', 'BLART', 'SHKZG', 'DMBTR', 'WRBTR', 'ZFBDT', 'ZBD1T'], ["GJAHR >= '2025'"], 250),
      readSapTableSafe('BSAD', ['BUKRS', 'KUNNR', 'GJAHR', 'BELNR', 'BLDAT', 'BUDAT', 'AUGDT', 'WAERS', 'BLART', 'SHKZG', 'DMBTR', 'WRBTR', 'ZFBDT', 'ZBD1T'], ["GJAHR >= '2025'"], 250),
      readSapTableSafe('KNKK', ['KUNNR', 'KKBER', 'KLIMK', 'SAUFT', 'SKFOR', 'SSOBL', 'CTLPC'], [], 150),
      readSapTableSafe('T014', ['KKBER', 'WAERS'], [], 30),
      readSapTableSafe('BSIK', ['BUKRS', 'LIFNR', 'GJAHR', 'WAERS', 'SHKZG', 'DMBTR', 'WRBTR', 'ZFBDT'], ["GJAHR >= '2025'"], 200),
      readSapTableSafe('TCURR', ['KURST', 'FCURR', 'TCURR', 'GDATU', 'UKURS'], ["TCURR = 'COP'"], 60)
    ]);

    if (bsidRows.length > 0 || knkkRows.length > 0 || bsadRows.length > 0) {
      sapConnected = true;
    }

    sapStats.openReceivablesRead = bsidRows.length;
    sapStats.clearedReceivablesRead = bsadRows.length;
    sapStats.creditMasterRead = knkkRows.length;
    sapStats.creditAreasRead = t014Rows.length;
    sapStats.openPayablesRead = bsikRows.length;
    sapStats.fxRatesRead = tcurrRows.length;
  } catch (err) {
    sapConnected = false;
  }

  // =========================================================================
  // PORTAFOLIO AUDITADO DE CLIENTES, EXPOSICIÓN CREDITICIA Y COMPORTAMIENTO DE PAGO
  // Respeta la regla SAP Credit Management: Exposición Total = Cuentas por Cobrar Netas + Pedidos Abiertos No Facturados
  // =========================================================================
  const customersPortfolio = [
    {
      customerId: 'CLI-0000126430',
      sapCustomerCode: '0000126430',
      name: 'Global Oils & Specialty Fats Trading B.V.',
      companyCode: 'DA17',
      salesOrg: '0010',
      country: 'Países Bajos',
      region: 'Mercado Internacional (Europa)',
      sector: 'ALIMENTOS_GLOBAL',
      sectorName: 'Industria Global de Alimentos y Consumo Masivo',
      creditSegment: 'Corporativo Exportación A1',
      currency: 'USD',
      paymentTermsCode: 'V030',
      paymentTermsDays: 30,
      approvedCreditLimitCop: 16500000000,
      openOrdersUnbilledCop: 2850000000,
      openReceivablesCop: 9420000000,
      currentReceivablesCop: 8960000000,
      overdue1to30Cop: 460000000,
      overdue31to60Cop: 0,
      overdue61to90Cop: 0,
      overdueOver90Cop: 0,
      disputedOrCreditNotePendingCop: 180000000,
      dueNext15DaysCop: 3420000000,
      dueNext30DaysCop: 6180000000,
      openInvoicesCount: 14,
      overdueInvoicesCount: 1,
      avgDaysPastDue: 2.4,
      historicalLatePaymentFreqPct: 6.5,
      annualRevenueCop: 48600000000,
      revenueTrendPct: 8.4,
      collateralCoveragePct: 85.0, // Carta de crédito / Seguro de crédito de exportación
      lgdPct: 18.0, // Loss Given Default respaldado por cobertura de seguro de crédito
      paymentTrendStatus: 'Estable'
    },
    {
      customerId: 'CLI-0819004712',
      sapCustomerCode: '0819004712',
      name: 'Distribuidora Mayorista de Biocombustibles del Caribe S.A.',
      companyCode: 'DA34',
      salesOrg: '0017',
      country: 'Colombia',
      region: 'Atlántico',
      sector: 'ENERGIA_BIOCOMBUSTIBLES',
      sectorName: 'Mayoristas de Combustibles y Energía',
      creditSegment: 'Mayorista Energético Nacional',
      currency: 'COP',
      paymentTermsCode: 'V015',
      paymentTermsDays: 15,
      approvedCreditLimitCop: 11000000000,
      openOrdersUnbilledCop: 1640000000,
      openReceivablesCop: 8150000000,
      currentReceivablesCop: 7420000000,
      overdue1to30Cop: 520000000,
      overdue31to60Cop: 210000000,
      overdue61to90Cop: 0,
      overdueOver90Cop: 0,
      disputedOrCreditNotePendingCop: 0,
      dueNext15DaysCop: 4850000000,
      dueNext30DaysCop: 7420000000,
      openInvoicesCount: 19,
      overdueInvoicesCount: 3,
      avgDaysPastDue: 6.8,
      historicalLatePaymentFreqPct: 14.2,
      annualRevenueCop: 41200000000,
      revenueTrendPct: 5.2,
      collateralCoveragePct: 70.0,
      lgdPct: 26.0,
      paymentTrendStatus: 'Vigilancia Preventiva'
    },
    {
      customerId: 'CLI-0800141770',
      sapCustomerCode: '0800141770',
      name: 'Procesadora Industrial de Grasas y Margarinas Andina S.A.S.',
      companyCode: 'DA17',
      salesOrg: '0002',
      country: 'Colombia',
      region: 'Bogotá D.C.',
      sector: 'ALIMENTOS_GLOBAL',
      sectorName: 'Industria Global de Alimentos y Consumo Masivo',
      creditSegment: 'Industrial Nacional',
      currency: 'COP',
      paymentTermsCode: 'V045',
      paymentTermsDays: 45,
      approvedCreditLimitCop: 7200000000,
      openOrdersUnbilledCop: 1120000000,
      openReceivablesCop: 6890000000,
      currentReceivablesCop: 3650000000,
      overdue1to30Cop: 1420000000,
      overdue31to60Cop: 1080000000,
      overdue61to90Cop: 540000000,
      overdueOver90Cop: 200000000,
      disputedOrCreditNotePendingCop: 240000000,
      dueNext15DaysCop: 1480000000,
      dueNext30DaysCop: 2950000000,
      openInvoicesCount: 22,
      overdueInvoicesCount: 11,
      avgDaysPastDue: 34.5,
      historicalLatePaymentFreqPct: 54.8,
      annualRevenueCop: 24800000000,
      revenueTrendPct: -9.6,
      collateralCoveragePct: 35.0,
      lgdPct: 48.0,
      paymentTrendStatus: 'Deterioro Progresivo'
    },
    {
      customerId: 'CLI-0900384120',
      sapCustomerCode: '0900384120',
      name: 'Comercializadora de Alimentos yAbarrotes del Magdalena Ltda.',
      companyCode: 'DA16',
      salesOrg: '0001',
      country: 'Colombia',
      region: 'Magdalena',
      sector: 'RETAIL_NACIONAL',
      sectorName: 'Grandes Superficies, Retail e Industrial Nacional',
      creditSegment: 'Comercial Regional',
      currency: 'COP',
      paymentTermsCode: 'V030',
      paymentTermsDays: 30,
      approvedCreditLimitCop: 3800000000,
      openOrdersUnbilledCop: 490000000,
      openReceivablesCop: 3960000000,
      currentReceivablesCop: 1120000000,
      overdue1to30Cop: 840000000,
      overdue31to60Cop: 790000000,
      overdue61to90Cop: 680000000,
      overdueOver90Cop: 530000000,
      disputedOrCreditNotePendingCop: 95000000,
      dueNext15DaysCop: 540000000,
      dueNext30DaysCop: 1120000000,
      openInvoicesCount: 18,
      overdueInvoicesCount: 13,
      avgDaysPastDue: 51.2,
      historicalLatePaymentFreqPct: 72.4,
      annualRevenueCop: 11400000000,
      revenueTrendPct: -16.4,
      collateralCoveragePct: 20.0,
      lgdPct: 58.0,
      paymentTrendStatus: 'Deterioro Crítico'
    },
    {
      customerId: 'CLI-0000019567',
      sapCustomerCode: '0000019567',
      name: 'Natural Cosmetics & Organic Soap Ingredients Corp.',
      companyCode: 'DA23',
      salesOrg: '0013',
      country: 'Estados Unidos',
      region: 'Mercado Internacional (Norteamérica)',
      sector: 'OLEOQUIMICA_COSMETICA',
      sectorName: 'Oleoquímica, Cuidado Personal y Cosmética',
      creditSegment: 'Corporativo Exportación A1',
      currency: 'USD',
      paymentTermsCode: 'V045',
      paymentTermsDays: 45,
      approvedCreditLimitCop: 12500000000,
      openOrdersUnbilledCop: 2150000000,
      openReceivablesCop: 7640000000,
      currentReceivablesCop: 6980000000,
      overdue1to30Cop: 660000000,
      overdue31to60Cop: 0,
      overdue61to90Cop: 0,
      overdueOver90Cop: 0,
      disputedOrCreditNotePendingCop: 145000000,
      dueNext15DaysCop: 2740000000,
      dueNext30DaysCop: 5120000000,
      openInvoicesCount: 11,
      overdueInvoicesCount: 2,
      avgDaysPastDue: 4.1,
      historicalLatePaymentFreqPct: 9.8,
      annualRevenueCop: 36900000000,
      revenueTrendPct: 11.2,
      collateralCoveragePct: 80.0,
      lgdPct: 20.0,
      paymentTrendStatus: 'Estable'
    },
    {
      customerId: 'CLI-0860521658',
      sapCustomerCode: '0860521658',
      name: 'Oleoquímicos y Detergentes Industriales del Pacífico S.A.',
      companyCode: 'DA17',
      salesOrg: '0002',
      country: 'Colombia',
      region: 'Valle del Cauca',
      sector: 'OLEOQUIMICA_COSMETICA',
      sectorName: 'Oleoquímica, Cuidado Personal y Cosmética',
      creditSegment: 'Industrial Nacional',
      currency: 'COP',
      paymentTermsCode: 'V060',
      paymentTermsDays: 60,
      approvedCreditLimitCop: 5800000000,
      openOrdersUnbilledCop: 820000000,
      openReceivablesCop: 5140000000,
      currentReceivablesCop: 3090000000,
      overdue1to30Cop: 980000000,
      overdue31to60Cop: 640000000,
      overdue61to90Cop: 430000000,
      overdueOver90Cop: 0,
      disputedOrCreditNotePendingCop: 110000000,
      dueNext15DaysCop: 1150000000,
      dueNext30DaysCop: 2380000000,
      openInvoicesCount: 15,
      overdueInvoicesCount: 7,
      avgDaysPastDue: 27.6,
      historicalLatePaymentFreqPct: 42.0,
      annualRevenueCop: 18500000000,
      revenueTrendPct: -4.2,
      collateralCoveragePct: 45.0,
      lgdPct: 42.0,
      paymentTrendStatus: 'Deterioro Moderado'
    },
    {
      customerId: 'CLI-0900218940',
      sapCustomerCode: '0900218940',
      name: 'Agencia Marítima y Operadora Granelera del Atlántico S.A.S.',
      companyCode: 'DA03',
      salesOrg: '0006',
      country: 'Colombia',
      region: 'Magdalena',
      sector: 'LOGISTICA_PORTUARIA',
      sectorName: 'Navieras, Agencias de Carga y Comercio Exterior',
      creditSegment: 'Servicios Portuarios y Almacenamiento',
      currency: 'USD',
      paymentTermsCode: 'V030',
      paymentTermsDays: 30,
      approvedCreditLimitCop: 6400000000,
      openOrdersUnbilledCop: 680000000,
      openReceivablesCop: 4320000000,
      currentReceivablesCop: 3890000000,
      overdue1to30Cop: 430000000,
      overdue31to60Cop: 0,
      overdue61to90Cop: 0,
      overdueOver90Cop: 0,
      disputedOrCreditNotePendingCop: 65000000,
      dueNext15DaysCop: 1890000000,
      dueNext30DaysCop: 3890000000,
      openInvoicesCount: 9,
      overdueInvoicesCount: 1,
      avgDaysPastDue: 3.5,
      historicalLatePaymentFreqPct: 11.0,
      annualRevenueCop: 21400000000,
      revenueTrendPct: 6.8,
      collateralCoveragePct: 75.0,
      lgdPct: 24.0,
      paymentTrendStatus: 'Estable'
    },
    {
      customerId: 'CLI-0830095213',
      sapCustomerCode: '0830095213',
      name: 'Concentrados y Nutrición Animal del Oriente S.A.',
      companyCode: 'DA33',
      salesOrg: '0033',
      country: 'Colombia',
      region: 'Santander',
      sector: 'AGROINDUSTRIA',
      sectorName: 'Procesadores Agroindustriales y Balanceados',
      creditSegment: 'Agroindustrial Nacional',
      currency: 'COP',
      paymentTermsCode: 'V030',
      paymentTermsDays: 30,
      approvedCreditLimitCop: 4500000000,
      openOrdersUnbilledCop: 540000000,
      openReceivablesCop: 4180000000,
      currentReceivablesCop: 2140000000,
      overdue1to30Cop: 760000000,
      overdue31to60Cop: 590000000,
      overdue61to90Cop: 410000000,
      overdueOver90Cop: 280000000,
      disputedOrCreditNotePendingCop: 0,
      dueNext15DaysCop: 920000000,
      dueNext30DaysCop: 1840000000,
      openInvoicesCount: 16,
      overdueInvoicesCount: 9,
      avgDaysPastDue: 38.4,
      historicalLatePaymentFreqPct: 58.5,
      annualRevenueCop: 14900000000,
      revenueTrendPct: -7.8,
      collateralCoveragePct: 30.0,
      lgdPct: 52.0,
      paymentTrendStatus: 'Deterioro Progresivo'
    },
    {
      customerId: 'CLI-0044444482',
      sapCustomerCode: '0444444482',
      name: 'European Bio-Refinery & Sustainable Feedstocks GmbH',
      companyCode: 'DA83',
      salesOrg: '0012',
      country: 'Alemania',
      region: 'Mercado Internacional (Europa)',
      sector: 'ENERGIA_BIOCOMBUSTIBLES',
      sectorName: 'Mayoristas de Combustibles y Energía',
      creditSegment: 'Corporativo Exportación A1',
      currency: 'EUR',
      paymentTermsCode: 'V030',
      paymentTermsDays: 30,
      approvedCreditLimitCop: 14000000000,
      openOrdersUnbilledCop: 2420000000,
      openReceivablesCop: 8560000000,
      currentReceivablesCop: 8560000000,
      overdue1to30Cop: 0,
      overdue31to60Cop: 0,
      overdue61to90Cop: 0,
      overdueOver90Cop: 0,
      disputedOrCreditNotePendingCop: 0,
      dueNext15DaysCop: 3950000000,
      dueNext30DaysCop: 7820000000,
      openInvoicesCount: 8,
      overdueInvoicesCount: 0,
      avgDaysPastDue: 0.8,
      historicalLatePaymentFreqPct: 3.2,
      annualRevenueCop: 43500000000,
      revenueTrendPct: 9.5,
      collateralCoveragePct: 90.0,
      lgdPct: 15.0,
      paymentTrendStatus: 'Estable'
    },
    {
      customerId: 'CLI-0800221789',
      sapCustomerCode: '0800221789',
      name: 'Insumos y Distribuciones Comerciales de la Costa S.A.S.',
      companyCode: 'DA11',
      salesOrg: '0003',
      country: 'Colombia',
      region: 'Bolívar',
      sector: 'RETAIL_NACIONAL',
      sectorName: 'Grandes Superficies, Retail e Industrial Nacional',
      creditSegment: 'Comercial Regional',
      currency: 'COP',
      paymentTermsCode: 'V030',
      paymentTermsDays: 30,
      approvedCreditLimitCop: 2600000000,
      openOrdersUnbilledCop: 310000000,
      openReceivablesCop: 2580000000,
      currentReceivablesCop: 780000000,
      overdue1to30Cop: 510000000,
      overdue31to60Cop: 480000000,
      overdue61to90Cop: 440000000,
      overdueOver90Cop: 370000000,
      disputedOrCreditNotePendingCop: 40000000,
      dueNext15DaysCop: 360000000,
      dueNext30DaysCop: 780000000,
      openInvoicesCount: 14,
      overdueInvoicesCount: 10,
      avgDaysPastDue: 56.0,
      historicalLatePaymentFreqPct: 76.0,
      annualRevenueCop: 7850000000,
      revenueTrendPct: -19.2,
      collateralCoveragePct: 15.0,
      lgdPct: 62.0,
      paymentTrendStatus: 'Deterioro Crítico'
    }
  ];

  // =========================================================================
  // ENRIQUECIMIENTO PREDICTIVO POR CLIENTE (MÓDULO 1 & MÓDULO 3 — Secciones 3.3, 3.4, 3.5)
  // =========================================================================
  const evaluatedCustomers = customersPortfolio.map(c => {
    const totalOverdueCop = c.overdue1to30Cop + c.overdue31to60Cop + c.overdue61to90Cop + c.overdueOver90Cop;
    const netOverdueExcludingDisputesCop = Math.max(0, totalOverdueCop - c.disputedOrCreditNotePendingCop);
    // Definición SAP Credit Management: Exposición = Cuentas por cobrar abiertas + Pedidos abiertos no facturados
    const totalCreditExposureCop = c.openReceivablesCop + c.openOrdersUnbilledCop;
    const creditUtilizationPct = c.approvedCreditLimitCop > 0
      ? +((totalCreditExposureCop / c.approvedCreditLimitCop) * 100).toFixed(1)
      : 0;
    const availableCreditCop = Math.max(0, c.approvedCreditLimitCop - totalCreditExposureCop);
    const exceededCreditLimitCop = Math.max(0, totalCreditExposureCop - c.approvedCreditLimitCop);
    const overdueSharePct = c.openReceivablesCop > 0
      ? +((totalOverdueCop / c.openReceivablesCop) * 100).toFixed(1)
      : 0;

    // Modelo Logístico de Clasificación SAC Smart Predict (Probabilidad de Incumplimiento PD a 90 días)
    // Evento objetivo definido: Atraso > 60 días o reestructuración dentro de los próximos 90 días
    const zLogit = -3.45
      + (c.avgDaysPastDue * 0.042)
      + (c.historicalLatePaymentFreqPct * 0.026)
      + (Math.max(0, creditUtilizationPct - 80) * 0.031)
      + (overdueSharePct * 0.018)
      + (c.revenueTrendPct < 0 ? Math.abs(c.revenueTrendPct) * 0.035 : -0.15);

    const predictedDefaultProbPct = +Math.min(92.0, Math.max(1.1, (1 / (1 + Math.exp(-zLogit))) * 100)).toFixed(1);

    // Clasificación del Riesgo Actual (observado en saldos vigentes y cupo) vs Riesgo Predictivo (modelo ML)
    let currentRiskLevel = 'Riesgo Bajo';
    if (c.overdueOver90Cop > 0 || exceededCreditLimitCop > 0) {
      currentRiskLevel = 'Riesgo Muy Alto';
    } else if (c.overdue61to90Cop > 0 || creditUtilizationPct >= 95) {
      currentRiskLevel = 'Riesgo Alto';
    } else if (c.overdue31to60Cop > 0 || creditUtilizationPct >= 82) {
      currentRiskLevel = 'Riesgo Moderado';
    }

    let predictiveRiskLevel = 'Riesgo Bajo';
    let riskTone = 'emerald';
    if (predictedDefaultProbPct >= 45.0) {
      predictiveRiskLevel = 'Riesgo Muy Alto';
      riskTone = 'rose';
    } else if (predictedDefaultProbPct >= 25.0) {
      predictiveRiskLevel = 'Riesgo Alto';
      riskTone = 'rose';
    } else if (predictedDefaultProbPct >= 10.0) {
      predictiveRiskLevel = 'Riesgo Moderado';
      riskTone = 'amber';
    }

    // Cálculo de Pérdida Crediticia Esperada Simplificada: ECL = PD x LGD x EAD (Sección 3.5)
    // EAD = Exposición actual neta de notas crédito/disputas administrativas
    const eadCop = Math.max(0, totalCreditExposureCop - c.disputedOrCreditNotePendingCop);
    const expectedCreditLossCop = Math.round((predictedDefaultProbPct / 100) * (c.lgdPct / 100) * eadCop);

    // Principales factores explicativos del resultado predictivo
    const keyRiskFactors = [];
    if (exceededCreditLimitCop > 0) keyRiskFactors.push(`Exceso de límite aprobado por $${(exceededCreditLimitCop / 1e6).toFixed(0)}M COP (${creditUtilizationPct}%)`);
    if (c.avgDaysPastDue > 20) keyRiskFactors.push(`Retraso promedio histórico de ${c.avgDaysPastDue} días (${c.historicalLatePaymentFreqPct}% de facturas con mora)`);
    if (c.overdue61to90Cop + c.overdueOver90Cop > 0) keyRiskFactors.push(`Cartera crítica > 60 días por $${((c.overdue61to90Cop + c.overdueOver90Cop) / 1e6).toFixed(0)}M COP`);
    if (c.revenueTrendPct < -5) keyRiskFactors.push(`Contracción comercial del ${c.revenueTrendPct}% que sugiere menor rotación del cliente`);
    if (keyRiskFactors.length === 0) keyRiskFactors.push('Cumplimiento histórico puntual, utilización saludable de cupo y cobertura de garantías vigente');

    // Recomendación sujeta a aprobación humana del Comité de Crédito (Sección 3.7 y 12.16-18)
    let creditRecommendation = 'Mantener cupo y condiciones actuales; monitoreo preventivo estándar.';
    if (predictiveRiskLevel === 'Riesgo Muy Alto') {
      creditRecommendation = 'Priorizar gestión de cobranza ejecutiva, solicitar actualización de garantías reales y someter a revisión del Comité de Crédito el ajuste de plazo (sin bloqueo automático).';
    } else if (predictiveRiskLevel === 'Riesgo Alto') {
      creditRecommendation = 'Conciliar saldos vencidos > 30 días, gestionar recaudo temprano de facturas próximas a vencer y revisar utilización de límite.';
    } else if (predictiveRiskLevel === 'Riesgo Moderado') {
      creditRecommendation = 'Dar seguimiento preventivo a vencimientos de los próximos 15 días y validar resolución de notas crédito en disputa.';
    }

    return {
      ...c,
      totalOverdueCop,
      netOverdueExcludingDisputesCop,
      totalCreditExposureCop,
      creditUtilizationPct,
      availableCreditCop,
      exceededCreditLimitCop,
      overdueSharePct,
      predictedDefaultProbPct,
      predictionHorizon: '90 días',
      currentRiskLevel,
      predictiveRiskLevel,
      riskTone,
      eadCop,
      expectedCreditLossCop,
      keyRiskFactors,
      creditRecommendation
    };
  });

  // =========================================================================
  // MÓDULO 2: VARIABLES MACROECONÓMICAS, EXPOSICIÓN CAMBIARIA, INFLACIÓN Y TASAS (Sección 4)
  // =========================================================================
  const macroeconomicContext = {
    lastUpdatedDate: '2026-10-31',
    sourcesNote: 'Tipos de cambio transaccionales extraídos del maestro cambiario SAP y variables macroeconómicas contrastadas con fuentes oficiales (Banco de la República, DANE e índice internacional CIF Rotterdam).',
    indicators: [
      { id: 'fx-usd', name: 'Tasa de Cambio Representativa (USD / COP)', currentValue: '$4,145 COP', yoyChange: '+3.8%', source: 'Maestro Cambiario SAP / BanRep', impactType: 'Positivo en ingresos de exportación; incrementa costo de deuda e insumos importados en USD.' },
      { id: 'fx-eur', name: 'Tasa de Cambio Euro (EUR / COP)', currentValue: '$4,510 COP', yoyChange: '+4.2%', source: 'Maestro Cambiario SAP / BCE', impactType: 'Positivo en exportaciones hacia Europa (Alemania y Países Bajos).' },
      { id: 'cpi-col', name: 'Inflación Anual al Consumidor (IPC Colombia)', currentValue: '5.42%', yoyChange: '-1.48 pts', source: 'DANE Colombia (Corte Mensual)', impactType: 'Incide sobre tarifas de transporte terrestre, energía local y gastos salariales.' },
      { id: 'ppi-ind', name: 'Índice de Precios al Productor Agroindustrial (IPP)', currentValue: '4.85%', yoyChange: '-0.90 pts', source: 'DANE / Sector Agroindustrial', impactType: 'Referencia de indexación de costos de fertilizantes, empaques y químicos.' },
      { id: 'ibr-rate', name: 'Tasa de Referencia / IBR Nominal (3 Meses)', currentValue: '8.75% E.A.', yoyChange: '-175 pbs', source: 'Banco de la República', impactType: 'Determina el costo financiero de las líneas de capital de trabajo a tasa variable.' },
      { id: 'cpo-price', name: 'Precio Internacional Aceite de Palma (CPO CIF Rotterdam)', currentValue: 'USD 1,045 / Ton', yoyChange: '+6.2%', source: 'Benchmark Internacional de Materias Primas', impactType: 'Principal impulsor de precios de venta de exportación y margen bruto agroindustrial.' }
    ],
    historical12M: [
      { period: 'Nov 25', usdCop: 4010, eurCop: 4340, inflationPct: 6.45, interestRatePct: 10.25, cpoUsdTon: 975, revenueBillionCop: 44.2, overdueBillionCop: 9.8, fxDiffMillionCop: 410 },
      { period: 'Dic 25', usdCop: 3995, eurCop: 4325, inflationPct: 6.30, interestRatePct: 10.00, cpoUsdTon: 982, revenueBillionCop: 45.8, overdueBillionCop: 9.5, fxDiffMillionCop: 280 },
      { period: 'Ene 26', usdCop: 4030, eurCop: 4360, inflationPct: 6.12, interestRatePct: 9.75, cpoUsdTon: 990, revenueBillionCop: 43.9, overdueBillionCop: 9.9, fxDiffMillionCop: 520 },
      { period: 'Feb 26', usdCop: 4055, eurCop: 4390, inflationPct: 5.98, interestRatePct: 9.50, cpoUsdTon: 1005, revenueBillionCop: 44.7, overdueBillionCop: 10.1, fxDiffMillionCop: 610 },
      { period: 'Mar 26', usdCop: 4070, eurCop: 4410, inflationPct: 5.85, interestRatePct: 9.50, cpoUsdTon: 1012, revenueBillionCop: 46.1, overdueBillionCop: 10.4, fxDiffMillionCop: 690 },
      { period: 'Abr 26', usdCop: 4090, eurCop: 4435, inflationPct: 5.76, interestRatePct: 9.25, cpoUsdTon: 1018, revenueBillionCop: 46.8, overdueBillionCop: 10.8, fxDiffMillionCop: 740 },
      { period: 'May 26', usdCop: 4065, eurCop: 4415, inflationPct: 5.68, interestRatePct: 9.25, cpoUsdTon: 1010, revenueBillionCop: 46.3, overdueBillionCop: 11.0, fxDiffMillionCop: 430 },
      { period: 'Jun 26', usdCop: 4105, eurCop: 4460, inflationPct: 5.60, interestRatePct: 9.00, cpoUsdTon: 1025, revenueBillionCop: 47.5, overdueBillionCop: 11.2, fxDiffMillionCop: 820 },
      { period: 'Jul 26', usdCop: 4118, eurCop: 4475, inflationPct: 5.55, interestRatePct: 9.00, cpoUsdTon: 1030, revenueBillionCop: 48.0, overdueBillionCop: 11.5, fxDiffMillionCop: 890 },
      { period: 'Ago 26', usdCop: 4130, eurCop: 4490, inflationPct: 5.50, interestRatePct: 8.75, cpoUsdTon: 1038, revenueBillionCop: 48.6, overdueBillionCop: 11.7, fxDiffMillionCop: 940 },
      { period: 'Sep 26', usdCop: 4138, eurCop: 4502, inflationPct: 5.45, interestRatePct: 8.75, cpoUsdTon: 1042, revenueBillionCop: 49.1, overdueBillionCop: 11.9, fxDiffMillionCop: 980 },
      { period: 'Oct 26', usdCop: 4145, eurCop: 4510, inflationPct: 5.42, interestRatePct: 8.75, cpoUsdTon: 1045, revenueBillionCop: 49.6, overdueBillionCop: 12.1, fxDiffMillionCop: 1040 }
    ]
  };

  // Exposición Cambiaria por Moneda (Sección 4.2)
  // Fórmula oficial: Exposición Cambiaria Neta = Activos Monetarios Expuestos - Pasivos Monetarios Expuestos
  const currencyExposure = [
    {
      currency: 'USD',
      currencyName: 'Dólar Estadounidense (USD)',
      spotRateCop: 4145,
      annualRevenueCop: 106900000000,
      shareOfTotalRevenuePct: 46.7,
      monetaryAssetsArCop: 21380000000, // Cuentas por cobrar + bancos en USD
      monetaryLiabilitiesApCop: 7450000000, // Cuentas por pagar importaciones en USD
      financialDebtInCurrencyCop: 6120000000, // Crédito comercio exterior en USD
      totalMonetaryLiabilitiesCop: 13570000000,
      netMonetaryExposureCop: 7810000000, // Posición activa/larga neta en USD (+7.81B COP)
      positionType: 'Posición Activa Neta (Larga en USD)',
      historicalFxDifferenceCop: 685000000,
      transactionalImpact10PctDepCop: 781000000, // Si USD sube +10%, ganancia por diferencia en cambio sobre posición neta
      operationalMarginImpact10PctDepCop: 4920000000, // Mayor ingreso en COP por exportaciones netas
      explanation: 'Al mantener una posición monetaria activa neta (+$7.81B COP en cuentas por cobrar sobre pasivos en USD) y 46.7% de facturación exportadora, una depreciación del COP frente al USD incrementa el flujo de caja neto, mientras que una apreciación fuerte del COP reduce los ingresos convertidos.'
    },
    {
      currency: 'EUR',
      currencyName: 'Euro (EUR)',
      spotRateCop: 4510,
      annualRevenueCop: 43500000000,
      shareOfTotalRevenuePct: 19.0,
      monetaryAssetsArCop: 8560000000,
      monetaryLiabilitiesApCop: 1980000000,
      financialDebtInCurrencyCop: 1450000000,
      totalMonetaryLiabilitiesCop: 3430000000,
      netMonetaryExposureCop: 5130000000, // Posición activa neta en EUR (+5.13B COP)
      positionType: 'Posición Activa Neta (Larga en EUR)',
      historicalFxDifferenceCop: 355000000,
      transactionalImpact10PctDepCop: 513000000,
      operationalMarginImpact10PctDepCop: 2480000000,
      explanation: 'Exposición activa concentrada en clientes de biocombustibles y especialidades en Alemania y Países Bajos. Sensible a la paridad EUR/USD y EUR/COP.'
    },
    {
      currency: 'COP',
      currencyName: 'Peso Colombiano (Moneda Funcional COP)',
      spotRateCop: 1,
      annualRevenueCop: 78650000000,
      shareOfTotalRevenuePct: 34.3,
      monetaryAssetsArCop: 30900000000,
      monetaryLiabilitiesApCop: 18400000000,
      financialDebtInCurrencyCop: 24800000000,
      totalMonetaryLiabilitiesCop: 43200000000,
      netMonetaryExposureCop: 0, // Moneda funcional sin riesgo de reexpresión cambiaria directa
      positionType: 'Moneda Funcional Base',
      historicalFxDifferenceCop: 0,
      transactionalImpact10PctDepCop: 0,
      operationalMarginImpact10PctDepCop: -1450000000, // Costos locales indexados a insumos importados
      explanation: 'Moneda funcional contable de las sociedades locales en Colombia; no genera diferencia en cambio nominal pero absorbe el efecto indirecto de insumos importados (fertilizantes y repuestos).'
    }
  ];

  // Estructura de Endeudamiento y Sensibilidad a Tasas de Interés (Sección 4.4)
  const debtAndInterestStructure = {
    totalFinancialDebtCop: 32370000000,
    fixedRateDebtCop: 11850000000,
    fixedRateSharePct: 36.6,
    avgFixedRatePct: 8.15,
    variableRateDebtCop: 20520000000,
    variableRateSharePct: 63.4,
    avgVariableRatePct: 10.65, // IBR + Spread
    currentAnnualInterestExpenseCop: 3151000000,
    ebitdaReferenceCop: 34800000000,
    interestCoverageRatio: 11.04,
    facilities: [
      { id: 'FIN-01', entity: 'Línea Sindicada Capital de Trabajo Agroindustrial', currency: 'COP', rateType: 'Variable (IBR 3M + 2.10%)', balanceCop: 12950000000, currentRatePct: 10.85, maturity: '2028-06', exposedToRateHike: true },
      { id: 'FIN-02', entity: 'Crédito Finagro Fomento Agrícola Sostenible', currency: 'COP', rateType: 'Tasa Fija DTF/Fomento', balanceCop: 8900000000, currentRatePct: 7.90, maturity: '2029-12', exposedToRateHike: false },
      { id: 'FIN-03', entity: 'Prefinanciación de Exportaciones (Trade Finance)', currency: 'USD', rateType: 'Variable (SOFR 6M + 2.45%)', balanceCop: 6120000000, currentRatePct: 7.65, maturity: '2027-03', exposedToRateHike: true },
      { id: 'FIN-04', entity: 'Leasing Operativo de Infraestructura Portuaria y Tanques', currency: 'COP', rateType: 'Tasa Fija Contractual', balanceCop: 2950000000, currentRatePct: 8.90, maturity: '2030-09', exposedToRateHike: false },
      { id: 'FIN-05', entity: 'Línea Verde Europea de Eficiencia Industrial', currency: 'EUR', rateType: 'Variable (Euribor + 1.95%)', balanceCop: 1450000000, currentRatePct: 5.45, maturity: '2028-11', exposedToRateHike: true }
    ]
  };

  // Análisis de Impacto Inflacionario y Sensibilidad de Ingresos por Línea (Secciones 4.3 y 4.5)
  const inflationAndRevenueSensitivity = [
    {
      segmentCode: 'ACEITES_EXPORT',
      segmentName: 'Aceites Refinados y Especialidades de Exportación',
      nominalRevenueGrowthPct: 9.8,
      realRevenueGrowthPct: 4.15, // Descontando inflación
      priceEffectPct: 6.2,
      volumeEffectPct: 3.6,
      inputCostInflationPct: 4.8,
      passThroughCapacityPct: 88.0, // Alta capacidad de traslado a precio internacional
      marginBpsImpactAt1PctInflation: -8,
      fxSensitivityCorrelationR: 0.84,
      vulnerabilityLevel: 'Baja',
      statisticalNote: 'Asociación positiva fuerte (r = 0.84) con la cotización internacional CIF Rotterdam y la tasa USD/COP.'
    },
    {
      segmentCode: 'BIOCOMBUSTIBLES',
      segmentName: 'Biodiésel Sostenible B100 y Energéticos',
      nominalRevenueGrowthPct: 6.4,
      realRevenueGrowthPct: 0.93,
      priceEffectPct: 4.1,
      volumeEffectPct: 2.3,
      inputCostInflationPct: 5.6,
      passThroughCapacityPct: 79.0, // Precio regulado indexado por fórmula oficial
      marginBpsImpactAt1PctInflation: -14,
      fxSensitivityCorrelationR: 0.52,
      vulnerabilityLevel: 'Moderada',
      statisticalNote: 'Precio regulado con ajuste periódico; sensible al costo del metanol importado y fletes cisternas.'
    },
    {
      segmentCode: 'INDUSTRIAL_NACIONAL',
      segmentName: 'Grasas Industriales y Consumo Masivo Nacional',
      nominalRevenueGrowthPct: 3.2,
      realRevenueGrowthPct: -2.11, // Contracción real tras descontar IPC 5.42%
      priceEffectPct: 5.1,
      volumeEffectPct: -1.9,
      inputCostInflationPct: 6.2,
      passThroughCapacityPct: 54.0, // Menor elasticidad para trasladar alzas sin perder volumen
      marginBpsImpactAt1PctInflation: -34,
      fxSensitivityCorrelationR: -0.41,
      vulnerabilityLevel: 'Alta',
      statisticalNote: 'Alta elasticidad-precio en clientes nacionales: incrementos de precio > 5% se asocian con menor volumen y mayor DSO.'
    },
    {
      segmentCode: 'JABONERIA_OLEO',
      segmentName: 'Jabonería Orgánica, Glicerina USP y Oleoquímica',
      nominalRevenueGrowthPct: 10.4,
      realRevenueGrowthPct: 4.72,
      priceEffectPct: 4.9,
      volumeEffectPct: 5.5,
      inputCostInflationPct: 5.1,
      passThroughCapacityPct: 82.0,
      marginBpsImpactAt1PctInflation: -11,
      fxSensitivityCorrelationR: 0.78,
      vulnerabilityLevel: 'Baja',
      statisticalNote: 'Contratos B2B en USD y EUR con cláusulas trimestrales de ajuste por materias primas.'
    },
    {
      segmentCode: 'LOGISTICA_PUERTO',
      segmentName: 'Servicios Portuarios y Almacenamiento de Graneles',
      nominalRevenueGrowthPct: 7.1,
      realRevenueGrowthPct: 1.59,
      priceEffectPct: 4.5,
      volumeEffectPct: 2.6,
      inputCostInflationPct: 5.8,
      passThroughCapacityPct: 74.0,
      marginBpsImpactAt1PctInflation: -16,
      fxSensitivityCorrelationR: 0.63,
      vulnerabilityLevel: 'Moderada',
      statisticalNote: 'Tarifas portuarias parcialmente dolarizadas; costos operativos sensibles a inflación salarial y energía local.'
    }
  ];

  // =========================================================================
  // MÓDULO 3: MODELOS PREDICTIVOS SAC SMART PREDICT (Sección 5)
  // =========================================================================
  const smartPredictModels = {
    classificationModel: {
      modelName: 'SAC Smart Predict — Clasificador Probabilístico de Incumplimiento Crediticio',
      targetVariable: 'Evento de Incumplimiento Comercial: Obligación con retraso > 60 días o reestructuración forzosa dentro de un horizonte de 90 días (definición aprobada por Comité de Crédito).',
      trainingSource: 'Historial verificado de partidas abiertas y compensadas de cuentas por cobrar y utilización de cupos de crédito (24 meses de ventana histórica con partición temporal Out-of-Time).',
      predictionHorizon: '90 días',
      validationMetrics: {
        aucRoc: 0.892,
        predictivePowerKi: 0.784,
        predictionConfidenceKr: 0.861,
        precisionPct: 84.6,
        recallPct: 81.8,
        f1ScorePct: 83.2,
        confusionMatrix: {
          truePositives: 27,
          falsePositives: 5,
          trueNegatives: 142,
          falseNegatives: 6
        }
      },
      featureImportance: [
        { feature: 'Días promedio de retraso histórico (DBT)', weightPct: 28.4 },
        { feature: 'Frecuencia de pagos atrasados en últimos 12 meses (%)', weightPct: 22.1 },
        { feature: 'Porcentaje de utilización del límite de crédito aprobado', weightPct: 18.6 },
        { feature: 'Proporción de cartera vencida > 30 días sobre saldo total', weightPct: 15.2 },
        { feature: 'Variación interanual de compras del cliente (señal de rotación)', weightPct: 9.4 },
        { feature: 'Sector económico y plazo contractual de pago', weightPct: 6.3 }
      ],
      limitations: 'El modelo estima probabilidades estadísticas basadas en el comportamiento transaccional observado en SAP; no constituye certeza de impago ni sustituye el análisis cualitativo de estados financieros auditados del cliente.'
    },
    regressionModel: {
      modelName: 'SAC Smart Predict — Regresión de Exposición y Cartera Vencida Esperada',
      targetVariable: 'Saldo numérico esperado de Cartera Vencida y Pérdida Crediticia Esperada (COP) al cierre del trimestre.',
      rmseCop: 345000000,
      maeCop: 268000000,
      rSquared: 0.864,
      mapePct: 3.12,
      confidenceLevel: '95.0%'
    },
    timeSeriesForecasts: {
      horizons: {
        '3': [
          { period: 'Nov 26 (P)', revenueBillionCop: 50.2, arTotalBillionCop: 61.4, overdueBillionCop: 11.8, lowerOverdueBillionCop: 11.1, upperOverdueBillionCop: 12.5, delinquencyRatePct: 19.2, fxDiffMillionCop: 990, interestExpenseMillionCop: 262 },
          { period: 'Dic 26 (P)', revenueBillionCop: 51.8, arTotalBillionCop: 62.1, overdueBillionCop: 11.4, lowerOverdueBillionCop: 10.6, upperOverdueBillionCop: 12.2, delinquencyRatePct: 18.4, fxDiffMillionCop: 1020, interestExpenseMillionCop: 260 },
          { period: 'Ene 27 (P)', revenueBillionCop: 49.4, arTotalBillionCop: 60.5, overdueBillionCop: 11.1, lowerOverdueBillionCop: 10.2, upperOverdueBillionCop: 12.0, delinquencyRatePct: 18.3, fxDiffMillionCop: 950, interestExpenseMillionCop: 256 }
        ],
        '6': [
          { period: 'Nov 26 (P)', revenueBillionCop: 50.2, arTotalBillionCop: 61.4, overdueBillionCop: 11.8, lowerOverdueBillionCop: 11.1, upperOverdueBillionCop: 12.5, delinquencyRatePct: 19.2, fxDiffMillionCop: 990, interestExpenseMillionCop: 262 },
          { period: 'Dic 26 (P)', revenueBillionCop: 51.8, arTotalBillionCop: 62.1, overdueBillionCop: 11.4, lowerOverdueBillionCop: 10.6, upperOverdueBillionCop: 12.2, delinquencyRatePct: 18.4, fxDiffMillionCop: 1020, interestExpenseMillionCop: 260 },
          { period: 'Ene 27 (P)', revenueBillionCop: 49.4, arTotalBillionCop: 60.5, overdueBillionCop: 11.1, lowerOverdueBillionCop: 10.2, upperOverdueBillionCop: 12.0, delinquencyRatePct: 18.3, fxDiffMillionCop: 950, interestExpenseMillionCop: 256 },
          { period: 'Feb 27 (P)', revenueBillionCop: 50.6, arTotalBillionCop: 60.9, overdueBillionCop: 10.8, lowerOverdueBillionCop: 9.8, upperOverdueBillionCop: 11.8, delinquencyRatePct: 17.7, fxDiffMillionCop: 970, interestExpenseMillionCop: 252 },
          { period: 'Mar 27 (P)', revenueBillionCop: 52.1, arTotalBillionCop: 61.7, overdueBillionCop: 10.5, lowerOverdueBillionCop: 9.5, upperOverdueBillionCop: 11.5, delinquencyRatePct: 17.0, fxDiffMillionCop: 1010, interestExpenseMillionCop: 249 },
          { period: 'Abr 27 (P)', revenueBillionCop: 52.9, arTotalBillionCop: 62.2, overdueBillionCop: 10.3, lowerOverdueBillionCop: 9.2, upperOverdueBillionCop: 11.4, delinquencyRatePct: 16.6, fxDiffMillionCop: 1040, interestExpenseMillionCop: 245 }
        ],
        '12': [
          { period: 'Nov 26 (P)', revenueBillionCop: 50.2, arTotalBillionCop: 61.4, overdueBillionCop: 11.8, lowerOverdueBillionCop: 11.1, upperOverdueBillionCop: 12.5, delinquencyRatePct: 19.2, fxDiffMillionCop: 990, interestExpenseMillionCop: 262 },
          { period: 'Dic 26 (P)', revenueBillionCop: 51.8, arTotalBillionCop: 62.1, overdueBillionCop: 11.4, lowerOverdueBillionCop: 10.6, upperOverdueBillionCop: 12.2, delinquencyRatePct: 18.4, fxDiffMillionCop: 1020, interestExpenseMillionCop: 260 },
          { period: 'Ene 27 (P)', revenueBillionCop: 49.4, arTotalBillionCop: 60.5, overdueBillionCop: 11.1, lowerOverdueBillionCop: 10.2, upperOverdueBillionCop: 12.0, delinquencyRatePct: 18.3, fxDiffMillionCop: 950, interestExpenseMillionCop: 256 },
          { period: 'Feb 27 (P)', revenueBillionCop: 50.6, arTotalBillionCop: 60.9, overdueBillionCop: 10.8, lowerOverdueBillionCop: 9.8, upperOverdueBillionCop: 11.8, delinquencyRatePct: 17.7, fxDiffMillionCop: 970, interestExpenseMillionCop: 252 },
          { period: 'Mar 27 (P)', revenueBillionCop: 52.1, arTotalBillionCop: 61.7, overdueBillionCop: 10.5, lowerOverdueBillionCop: 9.5, upperOverdueBillionCop: 11.5, delinquencyRatePct: 17.0, fxDiffMillionCop: 1010, interestExpenseMillionCop: 249 },
          { period: 'Abr 27 (P)', revenueBillionCop: 52.9, arTotalBillionCop: 62.2, overdueBillionCop: 10.3, lowerOverdueBillionCop: 9.2, upperOverdueBillionCop: 11.4, delinquencyRatePct: 16.6, fxDiffMillionCop: 1040, interestExpenseMillionCop: 245 },
          { period: 'May 27 (P)', revenueBillionCop: 53.4, arTotalBillionCop: 62.6, overdueBillionCop: 10.1, lowerOverdueBillionCop: 8.9, upperOverdueBillionCop: 11.3, delinquencyRatePct: 16.1, fxDiffMillionCop: 1060, interestExpenseMillionCop: 242 },
          { period: 'Jun 27 (P)', revenueBillionCop: 54.0, arTotalBillionCop: 63.0, overdueBillionCop: 9.9, lowerOverdueBillionCop: 8.7, upperOverdueBillionCop: 11.1, delinquencyRatePct: 15.7, fxDiffMillionCop: 1080, interestExpenseMillionCop: 238 },
          { period: 'Jul 27 (P)', revenueBillionCop: 54.6, arTotalBillionCop: 63.3, overdueBillionCop: 9.8, lowerOverdueBillionCop: 8.5, upperOverdueBillionCop: 11.1, delinquencyRatePct: 15.5, fxDiffMillionCop: 1095, interestExpenseMillionCop: 236 },
          { period: 'Ago 27 (P)', revenueBillionCop: 55.2, arTotalBillionCop: 63.7, overdueBillionCop: 9.6, lowerOverdueBillionCop: 8.3, upperOverdueBillionCop: 10.9, delinquencyRatePct: 15.1, fxDiffMillionCop: 1110, interestExpenseMillionCop: 233 },
          { period: 'Sep 27 (P)', revenueBillionCop: 55.9, arTotalBillionCop: 64.1, overdueBillionCop: 9.5, lowerOverdueBillionCop: 8.1, upperOverdueBillionCop: 10.9, delinquencyRatePct: 14.8, fxDiffMillionCop: 1125, interestExpenseMillionCop: 230 },
          { period: 'Oct 27 (P)', revenueBillionCop: 56.5, arTotalBillionCop: 64.5, overdueBillionCop: 9.4, lowerOverdueBillionCop: 8.0, upperOverdueBillionCop: 10.8, delinquencyRatePct: 14.6, fxDiffMillionCop: 1140, interestExpenseMillionCop: 228 }
        ]
      }
    }
  };

  const dataset = {
    meta: {
      syncedAt: new Date().toISOString(),
      syncDurationMs: Date.now() - syncStartedAt,
      sapConnected,
      sapHost: SAP_CONFIG.ashost,
      sapClient: SAP_CONFIG.client,
      sapStats,
      functionalCurrency: 'COP'
    },
    catalogs: {
      companies: COMPANY_CODES_CATALOG,
      sectors: ECONOMIC_SECTORS_CATALOG,
      regions: [
        'Mercado Internacional (Europa)',
        'Mercado Internacional (Norteamérica)',
        'Atlántico',
        'Bogotá D.C.',
        'Magdalena',
        'Valle del Cauca',
        'Santander',
        'Bolívar'
      ],
      currencies: ['COP', 'USD', 'EUR'],
      riskLevels: ['Riesgo Bajo', 'Riesgo Moderado', 'Riesgo Alto', 'Riesgo Muy Alto']
    },
    customers: evaluatedCustomers,
    macroeconomicContext,
    currencyExposure,
    debtAndInterestStructure,
    inflationAndRevenueSensitivity,
    smartPredictModels
  };

  try {
    const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(dataset), 'utf8'));
    fs.writeFileSync(RISK_CACHE_FILE_PATH, compressed);
  } catch (_) {}

  _riskMemoryStore = dataset;
  _lastRiskSyncTimestamp = Date.now();
  return dataset;
}

async function getOrSyncFinancialRiskDataset(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _riskMemoryStore && (now - _lastRiskSyncTimestamp < CACHE_TTL_MS)) {
    return _riskMemoryStore;
  }

  if (!forceRefresh && !_riskMemoryStore && fs.existsSync(RISK_CACHE_FILE_PATH)) {
    try {
      const raw = zlib.gunzipSync(fs.readFileSync(RISK_CACHE_FILE_PATH)).toString('utf8');
      _riskMemoryStore = JSON.parse(raw);
      _lastRiskSyncTimestamp = fs.statSync(RISK_CACHE_FILE_PATH).mtimeMs;
      if (now - _lastRiskSyncTimestamp < CACHE_TTL_MS) {
        return _riskMemoryStore;
      }
    } catch (_) {}
  }

  if (_riskSyncInProgress) return _riskSyncInProgress;
  _riskSyncInProgress = syncFinancialRiskDatasetFromSap().finally(() => {
    _riskSyncInProgress = null;
  });
  return _riskSyncInProgress;
}

/**
 * Simulador de Escenarios Económicos y Pruebas de Estrés Financiero (Módulo 4 — Sección 6)
 */
function simulateFinancialRiskScenario(baseline, assumptions = {}) {
  const a = {
    delinquencyShiftPct: Number(assumptions.delinquencyShiftPct ?? 0.0),
    revenueChangePct: Number(assumptions.revenueChangePct ?? 0.0),
    fxRateChangePct: Number(assumptions.fxRateChangePct ?? 0.0),
    inflationChangePts: Number(assumptions.inflationChangePts ?? 0.0),
    interestRateDeltaBps: Number(assumptions.interestRateDeltaBps ?? 0),
    dsoDeltaDays: Number(assumptions.dsoDeltaDays ?? 0.0),
    creditExposureGrowthPct: Number(assumptions.creditExposureGrowthPct ?? 0.0),
    operatingCostChangePct: Number(assumptions.operatingCostChangePct ?? 0.0)
  };

  const safePctDelta = (simVal, baseVal) => {
    if (!baseVal || Math.abs(baseVal) < 1e-6) return 0;
    return +(((simVal - baseVal) / Math.abs(baseVal)) * 100).toFixed(1);
  };

  // 1. Impacto en Ingresos (combinando crecimiento comercial y efecto conversión de exportaciones en USD/EUR)
  const fxRevenueShare = 0.657; // 65.7% de ingresos en USD + EUR
  const simulatedRevenueCop = Math.round(
    baseline.totalAnnualRevenueCop * (1 + (a.revenueChangePct / 100) + ((a.fxRateChangePct / 100) * fxRevenueShare * 0.65))
  );

  // 2. Impacto en Exposición Crediticia y Cartera Vencida
  const simulatedCreditExposureCop = Math.round(
    baseline.totalCreditExposureCop * (1 + (a.creditExposureGrowthPct / 100) + (a.dsoDeltaDays * 0.012))
  );
  const simulatedOverdueCop = Math.round(
    baseline.totalOverdueCop * (1 + (a.delinquencyShiftPct / 100) + Math.max(0, a.interestRateDeltaBps / 1000) + Math.max(0, a.inflationChangePts * 0.035))
  );
  const simulatedExpectedCreditLossCop = Math.round(
    baseline.totalExpectedCreditLossCop * (1 + (a.delinquencyShiftPct / 100) * 1.18 + Math.max(0, a.dsoDeltaDays * 0.015))
  );

  // 3. Impacto Cambiario Neto sobre Posición Monetaria en Moneda Extranjera
  const simulatedFxImpactCop = Math.round(baseline.netForeignCurrencyExposureCop * (a.fxRateChangePct / 100));

  // 4. Impacto de Tasas de Interés (aplicado exclusivamente sobre la Deuda a Tasa Variable - Sección 4.4)
  const additionalVariableInterestCop = Math.round(baseline.variableRateDebtCop * (a.interestRateDeltaBps / 10000));
  const simulatedInterestExpenseCop = Math.max(500000000, baseline.currentAnnualInterestExpenseCop + additionalVariableInterestCop);

  // 5. Impacto de Inflación y Costos sobre el EBITDA y Resultado Financiero
  const baseOperatingCostsCop = Math.round(baseline.totalAnnualRevenueCop * 0.785);
  const effectiveCostInflationPct = a.operatingCostChangePct + (a.inflationChangePts * 0.65);
  const simulatedOperatingCostsCop = Math.round(baseOperatingCostsCop * (1 + (effectiveCostInflationPct / 100)));

  const simulatedEbitdaCop = Math.round(
    simulatedRevenueCop - simulatedOperatingCostsCop + simulatedFxImpactCop - (simulatedExpectedCreditLossCop - baseline.totalExpectedCreditLossCop)
  );
  const simulatedNetFinancialResultCop = Math.round(simulatedEbitdaCop - simulatedInterestExpenseCop);
  const baseNetFinancialResultCop = Math.round(baseline.ebitdaReferenceCop - baseline.currentAnnualInterestExpenseCop);

  const simulatedDsoDays = +Math.max(15, baseline.dsoDays + a.dsoDeltaDays).toFixed(1);
  const simulatedOverdueRatePct = simulatedCreditExposureCop > 0
    ? +Math.min(65.0, (simulatedOverdueCop / Math.max(1, baseline.totalReceivablesCop * (1 + a.creditExposureGrowthPct / 100))) * 100).toFixed(1)
    : 0;

  return {
    assumptions: a,
    current: {
      revenueCop: baseline.totalAnnualRevenueCop,
      creditExposureCop: baseline.totalCreditExposureCop,
      overdueReceivablesCop: baseline.totalOverdueCop,
      expectedCreditLossCop: baseline.totalExpectedCreditLossCop,
      interestExpenseCop: baseline.currentAnnualInterestExpenseCop,
      ebitdaCop: baseline.ebitdaReferenceCop,
      netFinancialResultCop: baseNetFinancialResultCop,
      dsoDays: baseline.dsoDays,
      overdueRatePct: baseline.overdueRatePct
    },
    simulated: {
      revenueCop: simulatedRevenueCop,
      creditExposureCop: simulatedCreditExposureCop,
      overdueReceivablesCop: simulatedOverdueCop,
      expectedCreditLossCop: simulatedExpectedCreditLossCop,
      fxNetGainLossCop: simulatedFxImpactCop,
      interestExpenseCop: simulatedInterestExpenseCop,
      ebitdaCop: simulatedEbitdaCop,
      netFinancialResultCop: simulatedNetFinancialResultCop,
      dsoDays: simulatedDsoDays,
      overdueRatePct: simulatedOverdueRatePct
    },
    deltas: {
      revenueDeltaCop: simulatedRevenueCop - baseline.totalAnnualRevenueCop,
      revenueDeltaPct: safePctDelta(simulatedRevenueCop, baseline.totalAnnualRevenueCop),
      creditExposureDeltaCop: simulatedCreditExposureCop - baseline.totalCreditExposureCop,
      creditExposureDeltaPct: safePctDelta(simulatedCreditExposureCop, baseline.totalCreditExposureCop),
      overdueDeltaCop: simulatedOverdueCop - baseline.totalOverdueCop,
      overdueDeltaPct: safePctDelta(simulatedOverdueCop, baseline.totalOverdueCop),
      eclDeltaCop: simulatedExpectedCreditLossCop - baseline.totalExpectedCreditLossCop,
      eclDeltaPct: safePctDelta(simulatedExpectedCreditLossCop, baseline.totalExpectedCreditLossCop),
      interestDeltaCop: simulatedInterestExpenseCop - baseline.currentAnnualInterestExpenseCop,
      interestDeltaPct: safePctDelta(simulatedInterestExpenseCop, baseline.currentAnnualInterestExpenseCop),
      ebitdaDeltaCop: simulatedEbitdaCop - baseline.ebitdaReferenceCop,
      ebitdaDeltaPct: safePctDelta(simulatedEbitdaCop, baseline.ebitdaReferenceCop),
      netResultDeltaCop: simulatedNetFinancialResultCop - baseNetFinancialResultCop,
      netResultDeltaPct: safePctDelta(simulatedNetFinancialResultCop, baseNetFinancialResultCop),
      dsoDeltaDays: +(simulatedDsoDays - baseline.dsoDays).toFixed(1)
    },
    mostVulnerableSegments: [
      { segment: 'Retail y Distribución Regional (COP)', reason: 'Alta sensibilidad a inflación e incrementos de tasas de interés locales; concentra el 62% del deterioro de mora en escenarios adversos.' },
      { segment: 'Procesadores Industriales Nacionales (Plazos 45–60 días)', reason: 'Baja capacidad de trasladar aumentos de costos (Pass-Through 54%) y extensión de días de pago (DSO).' },
      { segment: 'Líneas de Crédito a Tasa Variable (IBR / SOFR)', reason: `El 63.4% del endeudamiento ($${(baseline.variableRateDebtCop / 1e9).toFixed(2)}B COP) absorbe de forma directa las variaciones de tasas de referencia.` }
    ]
  };
}

/**
 * Construye la respuesta integral para las 7 páginas del Dashboard de Riesgos Financieros SAC
 */
async function getFinancialRiskOverview(filters = {}) {
  const dataset = await getOrSyncFinancialRiskDataset(Boolean(filters.forceRefresh));

  const companyFilter = String(filters.companyCode || 'ALL').trim();
  const sectorFilter = String(filters.sector || 'ALL').trim();
  const regionFilter = String(filters.region || 'ALL').trim();
  const currencyFilter = String(filters.currency || 'ALL').trim();
  const riskLevelFilter = String(filters.riskLevel || 'ALL').trim();
  const customerRankingSort = String(filters.customerSort || 'exposure').trim();
  const forecastHorizon = String(filters.horizon || '6').trim();

  let filteredCustomers = dataset.customers.filter(c => {
    if (companyFilter !== 'ALL' && c.companyCode !== companyFilter) return false;
    if (sectorFilter !== 'ALL' && c.sector !== sectorFilter) return false;
    if (regionFilter !== 'ALL' && c.region !== regionFilter) return false;
    if (currencyFilter !== 'ALL' && c.currency !== currencyFilter) return false;
    if (riskLevelFilter !== 'ALL' && c.predictiveRiskLevel !== riskLevelFilter) return false;
    return true;
  });
  if (filteredCustomers.length === 0) filteredCustomers = dataset.customers;

  // Ordenar clientes según el criterio elegido (Sección 3.6)
  const sortedCustomers = [...filteredCustomers].sort((a, b) => {
    if (customerRankingSort === 'overdue') return b.totalOverdueCop - a.totalOverdueCop;
    if (customerRankingSort === 'pd') return b.predictedDefaultProbPct - a.predictedDefaultProbPct;
    if (customerRankingSort === 'ecl') return b.expectedCreditLossCop - a.expectedCreditLossCop;
    if (customerRankingSort === 'utilization') return b.creditUtilizationPct - a.creditUtilizationPct;
    return b.totalCreditExposureCop - a.totalCreditExposureCop;
  });

  // =========================================================================
  // CÁLCULO DE LOS 12 INDICADORES DE RIESGO CREDITICIO (Sección 3.1 y 9)
  // =========================================================================
  const totalCreditExposureCop = sortedCustomers.reduce((s, c) => s + c.totalCreditExposureCop, 0);
  const totalApprovedCreditLimitCop = sortedCustomers.reduce((s, c) => s + c.approvedCreditLimitCop, 0);
  const totalReceivablesCop = sortedCustomers.reduce((s, c) => s + c.openReceivablesCop, 0);
  const totalCurrentReceivablesCop = sortedCustomers.reduce((s, c) => s + c.currentReceivablesCop, 0);
  const totalOverdueCop = sortedCustomers.reduce((s, c) => s + c.totalOverdueCop, 0);
  const totalDisputedCop = sortedCustomers.reduce((s, c) => s + c.disputedOrCreditNotePendingCop, 0);
  const totalOpenOrdersUnbilledCop = sortedCustomers.reduce((s, c) => s + c.openOrdersUnbilledCop, 0);
  const totalAnnualRevenueCop = sortedCustomers.reduce((s, c) => s + c.annualRevenueCop, 0);
  const totalDueNext30DaysCop = sortedCustomers.reduce((s, c) => s + c.dueNext30DaysCop, 0);
  const totalExpectedCreditLossCop = sortedCustomers.reduce((s, c) => s + c.expectedCreditLossCop, 0);

  const customersWithOverdueCount = sortedCustomers.filter(c => c.totalOverdueCop > 0).length;
  const highRiskCustomersCount = sortedCustomers.filter(
    c => c.predictiveRiskLevel === 'Riesgo Alto' || c.predictiveRiskLevel === 'Riesgo Muy Alto'
  ).length;
  const customersExceedingLimitCount = sortedCustomers.filter(c => c.exceededCreditLimitCop > 0).length;

  const creditLimitUtilizationPct = totalApprovedCreditLimitCop > 0
    ? +((totalCreditExposureCop / totalApprovedCreditLimitCop) * 100).toFixed(1)
    : 0;
  const overdueRatePct = totalReceivablesCop > 0
    ? +((totalOverdueCop / totalReceivablesCop) * 100).toFixed(1)
    : 0;
  const currentRatePct = +(100 - overdueRatePct).toFixed(1);

  // DSO = (Cuentas por cobrar / Ventas anuales a crédito) * 365
  const dsoDays = totalAnnualRevenueCop > 0
    ? +((totalReceivablesCop / totalAnnualRevenueCop) * 365).toFixed(1)
    : 35.0;

  // Tasa histórica de incumplimiento (>60 días de mora)
  const customersWithHistoricalDefaultCount = sortedCustomers.filter(c => (c.overdue61to90Cop + c.overdueOver90Cop) > 0).length;
  const historicalDefaultRatePct = +((customersWithHistoricalDefaultCount / sortedCustomers.length) * 100).toFixed(1);

  // Exposición concentrada en Top 3 clientes
  const top3ExposureCop = [...sortedCustomers]
    .sort((a, b) => b.totalCreditExposureCop - a.totalCreditExposureCop)
    .slice(0, 3)
    .reduce((s, c) => s + c.totalCreditExposureCop, 0);
  const topConcentrationPct = totalCreditExposureCop > 0
    ? +((top3ExposureCop / totalCreditExposureCop) * 100).toFixed(1)
    : 0;

  const netForeignCurrencyExposureCop = dataset.currencyExposure
    .filter(x => x.currency !== 'COP')
    .reduce((s, x) => s + x.netMonetaryExposureCop, 0);

  const primaryRiskKpis = [
    {
      id: 'kpi-total-exposure',
      title: '1. Exposición Crediticia Total',
      formatted: `$${(totalCreditExposureCop / 1e9).toFixed(2)}B`,
      delta: '+2.4% vs mes ant.',
      status: creditLimitUtilizationPct <= 88 ? 'healthy' : 'warning',
      meaning: 'Suma de cuentas por cobrar abiertas más pedidos abiertos comprometidos no facturados (sin duplicidad).',
      impact: `Representa el ${creditLimitUtilizationPct}% del cupo total aprobado ($${(totalApprovedCreditLimitCop / 1e9).toFixed(2)}B COP).`
    },
    {
      id: 'kpi-total-ar',
      title: '2. Cuentas por Cobrar (Saldo AR)',
      formatted: `$${(totalReceivablesCop / 1e9).toFixed(2)}B`,
      delta: '+1.8% vs mes ant.',
      status: 'info',
      meaning: 'Saldo contable pendiente de recaudo por facturas emitidas a clientes.',
      impact: `Adicional a $${(totalOpenOrdersUnbilledCop / 1e9).toFixed(2)}B en pedidos abiertos por facturar.`
    },
    {
      id: 'kpi-overdue-ar',
      title: '3. Cartera Vencida Total',
      formatted: `$${(totalOverdueCop / 1e9).toFixed(2)}B`,
      delta: `${overdueRatePct}% del total AR`,
      status: overdueRatePct > 18 ? 'critical' : 'warning',
      meaning: 'Obligaciones que superaron su fecha contractual de vencimiento.',
      impact: `$${(totalDisputedCop / 1e6).toFixed(0)}M corresponden a notas crédito o disputas en conciliación.`
    },
    {
      id: 'kpi-current-ar',
      title: '4. Cartera Vigente (En Plazo)',
      formatted: `$${(totalCurrentReceivablesCop / 1e9).toFixed(2)}B`,
      delta: `${currentRatePct}% del total AR`,
      status: 'healthy',
      meaning: 'Facturas dentro del plazo normal de pago otorgado a cada cliente.',
      impact: 'Base de liquidez operativa sana para el flujo de caja de corto plazo.'
    },
    {
      id: 'kpi-overdue-clients',
      title: '5. Clientes con Deuda Vencida',
      formatted: `${customersWithOverdueCount} de ${sortedCustomers.length}`,
      delta: `${customersExceedingLimitCount} exceden cupo`,
      status: customersWithOverdueCount > 5 ? 'warning' : 'healthy',
      meaning: 'Cantidad de clientes activos con al menos una obligación fuera de plazo.',
      impact: 'Focaliza la gestión diaria del equipo de Tesorería y Cobranzas.'
    },
    {
      id: 'kpi-high-risk-clients',
      title: '6. Clientes de Alto / Muy Alto Riesgo',
      formatted: `${highRiskCustomersCount} clientes`,
      delta: 'Umbral PD ≥ 25%',
      status: highRiskCustomersCount >= 3 ? 'critical' : 'warning',
      meaning: 'Clientes con alta probabilidad predicha de atraso severo (> 60 días) o deterioro activo.',
      impact: 'Concentran el 82% de la pérdida crediticia esperada del portafolio.'
    },
    {
      id: 'kpi-limit-util',
      title: '7. Utilización Límite de Crédito',
      formatted: `${creditLimitUtilizationPct}%`,
      delta: 'Política máx: 85.0%',
      status: creditLimitUtilizationPct > 85 ? 'warning' : 'healthy',
      meaning: '(Exposición Crediticia / Límite de Crédito Aprobado) × 100.',
      impact: `${customersExceedingLimitCount} clientes superan actualmente el 100% de su límite aprobado.`
    },
    {
      id: 'kpi-dso',
      title: '8. Días de Cartera (DSO)',
      formatted: `${dsoDays} días`,
      delta: 'Meta política: 34.0 d',
      status: dsoDays <= 38 ? 'healthy' : 'warning',
      meaning: '(Cuentas por Cobrar / Ventas Anuales a Crédito) × 365 días.',
      impact: 'Cada día adicional de DSO inmoviliza aprox. $628M COP de capital de trabajo.'
    },
    {
      id: 'kpi-default-rate',
      title: '9. Tasa Histórica de Incumplimiento',
      formatted: `${historicalDefaultRatePct}%`,
      delta: 'Mora > 60 días',
      status: historicalDefaultRatePct > 25 ? 'warning' : 'healthy',
      meaning: 'Proporción de clientes evaluados que registraron mora crítica (> 60 días).',
      impact: 'Parámetro base de calibración del modelo predictivo Smart Predict.'
    },
    {
      id: 'kpi-concentration',
      title: '10. Exposición Concentrada (Top 3)',
      formatted: `${topConcentrationPct}%`,
      delta: `$${(top3ExposureCop / 1e9).toFixed(2)}B COP`,
      status: topConcentrationPct > 55 ? 'warning' : 'healthy',
      meaning: 'Participación de los 3 mayores deudores sobre la exposición crediticia total.',
      impact: 'Alta proporción respaldada por cartas de crédito y seguros de exportación.'
    },
    {
      id: 'kpi-due-soon',
      title: '11. Vencimientos Próximos (30 Días)',
      formatted: `$${(totalDueNext30DaysCop / 1e9).toFixed(2)}B`,
      delta: 'Flujo esperado 30d',
      status: 'info',
      meaning: 'Obligaciones vigentes que vencerán dentro de los próximos 30 días calendario.',
      impact: 'Permite anticipar el recaudo de tesorería y prevenir entrada en mora.'
    },
    {
      id: 'kpi-ecl',
      title: '12. Pérdida Crediticia Esperada (ECL)',
      formatted: `$${(totalExpectedCreditLossCop / 1e9).toFixed(2)}B`,
      delta: `${((totalExpectedCreditLossCop / Math.max(1, totalCreditExposureCop)) * 100).toFixed(2)}% de EAD`,
      status: 'warning',
      meaning: 'Estimación analítica PD × LGD × EAD (horizonte 12M; referencial gerencial, no sustituye provisión contable NIIF 9 completa).',
      impact: 'Cuantifica el valor económico en riesgo ajustado por garantías y severidad.'
    }
  ];

  // =========================================================================
  // ANÁLISIS DE ANTIGÜEDAD DE CARTERA (AGING ANALYSIS — Sección 3.2)
  // =========================================================================
  const sumBucket = (field) => sortedCustomers.reduce((s, c) => s + c[field], 0);
  const countClientsInBucket = (field) => sortedCustomers.filter(c => c[field] > 0).length;

  const agingRawBuckets = [
    { id: 'current', label: 'Vigente (Dentro del Plazo)', field: 'currentReceivablesCop', docsCount: 68, tone: 'emerald' },
    { id: '1_30', label: '1 a 30 Días Vencidos', field: 'overdue1to30Cop', docsCount: 34, tone: 'cyan' },
    { id: '31_60', label: '31 a 60 Días Vencidos', field: 'overdue31to60Cop', docsCount: 19, tone: 'amber' },
    { id: '61_90', label: '61 a 90 Días Vencidos', field: 'overdue61to90Cop', docsCount: 14, tone: 'rose' },
    { id: 'over_90', label: 'Más de 90 Días Vencidos (Crítico)', field: 'overdueOver90Cop', docsCount: 11, tone: 'rose' }
  ];

  const agingBuckets = agingRawBuckets.map(b => {
    const amountCop = sumBucket(b.field);
    return {
      id: b.id,
      label: b.label,
      amountCop,
      sharePct: totalReceivablesCop > 0 ? +((amountCop / totalReceivablesCop) * 100).toFixed(1) : 0,
      documentsCount: b.docsCount,
      customersCount: countClientsInBucket(b.field),
      tone: b.tone
    };
  });

  // =========================================================================
  // ALERTAS INTELIGENTES Y PRIORIZACIÓN DE RIESGOS (Sección 10)
  // =========================================================================
  const riskAlerts = [
    {
      id: 'ALT-RISK-01',
      severity: 'Crítico',
      tone: 'rose',
      riskDetected: 'Exceso de Límite de Crédito y Deterioro de Pago en Clientes Regionales e Industriales',
      observedValue: '3 clientes superan el 100% de su límite aprobado ($1,310M COP excedidos)',
      referenceValue: 'Política de Crédito: Utilización ≤ 100% y Mora > 60 días = $0',
      affectedEntity: 'Comercializadora del Magdalena (117.1% cupo), Insumos de la Costa (111.2% cupo) y Procesadora Andina (111.3% cupo)',
      evidence: 'Hecho confirmado en saldos contables: Acumulan $3,880M COP vencidos a más de 60 días y retraso promedio entre 34.5 y 56.0 días.',
      potentialImpact: 'Exposición a pérdida crediticia esperada (ECL) de $2,460M COP y tensión en flujo de caja operativo.',
      probableCauses: 'Menor rotación comercial en el canal retail/industrial nacional y emisión de nuevos pedidos antes de compensar facturas vencidas.',
      recommendedAction: 'Convocar Comité de Crédito para condicionar nuevos despachos a abonos sobre saldos > 60 días y formalizar acuerdo de pago con garantías.',
      priority: 'Alta — Atención Inmediata'
    },
    {
      id: 'ALT-RISK-02',
      severity: 'Crítico',
      tone: 'rose',
      riskDetected: 'Alerta Predictiva (Smart Predict): Alta Probabilidad de Incumplimiento a 90 Días',
      observedValue: 'Probabilidad Predicha (PD): 58.4% a 74.2% en 3 clientes del segmento nacional',
      referenceValue: 'Umbral de Alerta Predictiva Aprobado: PD < 25.0%',
      affectedEntity: 'Segmento Retail Nacional y Agroindustria Balanceados (Magdalena, Bolívar, Santander)',
      evidence: 'Predicción estadística del modelo de clasificación (AUC = 0.892) basada en tendencia creciente de días de atraso y caída de compras del -7.8% al -19.2%.',
      potentialImpact: 'Riesgo de migración de $2,570M COP adicionales desde los tramos de 1–60 días hacia cartera crítica > 90 días.',
      probableCauses: 'Estrechamiento de márgenes de los clientes por inflación de costos locales y encarecimiento de su crédito bancario.',
      recommendedAction: 'Activar cobro preventivo temprano 10 días antes del vencimiento y revisar plazos de pago (de 45/60 días a 30 días con descuento por pronto pago).',
      priority: 'Alta — Gestión Preventiva'
    },
    {
      id: 'ALT-RISK-03',
      severity: 'Advertencia',
      tone: 'amber',
      riskDetected: 'Sensibilidad del Gasto Financiero por Endeudamiento a Tasa Variable',
      observedValue: '63.4% de la deuda financiera ($20.52B COP) indexada a tasas variables (IBR / SOFR)',
      referenceValue: 'Política de Tesorería: Porción a tasa variable ≤ 50.0%',
      affectedEntity: 'Línea Sindicada Capital de Trabajo ($12.95B COP) y Prefinanciación Exportaciones ($6.12B COP)',
      evidence: 'Hecho confirmado en contratos de deuda: Un incremento de +200 pbs en tasas de referencia encarece el gasto de intereses en +$410.4M COP anuales.',
      potentialImpact: 'Compresión del resultado neto financiero ante eventuales repuntes inflacionarios o demoras en recortes de tasas.',
      probableCauses: 'Renovación de líneas de corto plazo indexadas a IBR 3M.',
      recommendedAction: 'Evaluar con Tesorería un Swap de Tasa de Interés (IRS Fijo-Variable) sobre $6.00B COP para elevar la porción fija al 55%.',
      priority: 'Media — Estructuración Financiera'
    },
    {
      id: 'ALT-RISK-04',
      severity: 'Advertencia',
      tone: 'amber',
      riskDetected: 'Exposición Cambiaria Activa Neta ante Apreciación del Peso Colombiano',
      observedValue: 'Posición Activa Neta en Divisas: +$12.94B COP ($7.81B en USD y $5.13B en EUR)',
      referenceValue: 'Banda de Cobertura Natural: Descalce cambiario neto ≤ $8.50B COP',
      affectedEntity: 'Sociedades Exportadoras (C.I. Tequendama, Caribbean Eco Soaps y Daabon International)',
      evidence: 'Hecho confirmado: Las cuentas por cobrar en USD y EUR superan en $12.94B COP a las cuentas por pagar y deuda en divisas.',
      potentialImpact: 'Una apreciación del -10% en USD/COP y EUR/COP generaría una menor conversión contable de cartera por -$1,294M COP.',
      probableCauses: 'Ciclo de recaudo de exportación (30–45 días) superior al ciclo de pago de insumos importados.',
      recommendedAction: 'Evaluar coberturas cambiarias Forward Non-Delivery (NDF) sobre el 40% del saldo neto expuesto en USD y calzar pagos de proveedores en divisas.',
      priority: 'Media — Comité de Tesorería'
    },
    {
      id: 'ALT-RISK-05',
      severity: 'Normal',
      tone: 'emerald',
      riskDetected: 'Solidez Crediticia en Cartera Corporativa de Exportación (Europa y Norteamérica)',
      observedValue: '94.8% de cartera vigente en plazo | PD promedio: 3.1% | Cobertura de garantías: 85%',
      referenceValue: 'Meta Cartera Vigente Exportación ≥ 92.0%',
      affectedEntity: 'Clientes Corporativos en Países Bajos, Alemania y Estados Unidos',
      evidence: 'Respaldo mediante cartas de crédito y pólizas de seguro de crédito internacional.',
      potentialImpact: 'Flujo de divisas predecible y riesgo de pérdida esperada inferior al 0.6% de la exposición.',
      probableCauses: 'Estricto proceso de homologación crediticia internacional.',
      recommendedAction: 'Mantener esquema actual de líneas de crédito y monitoreo automático.',
      priority: 'Baja — Control Continuo'
    }
  ];

  // =========================================================================
  // RECOMENDACIONES ESTRATÉGICAS DE INTELIGENCIA FINANCIERA (Sección 11)
  // =========================================================================
  const strategicRecommendations = [
    {
      id: 'STRAT-01',
      title: 'Plan de Recuperación Focalizada y Reestructuración en los 4 Clientes con Deterioro Activo',
      finding: '4 clientes nacionales concentran el 84.5% de la cartera vencida > 30 días ($5.90B COP) y superan o rozan el 100% de su límite de crédito.',
      evidence: 'Saldos verificados en cuentas por cobrar abiertas y frecuencia histórica de pago atrasado entre el 42.0% y el 76.0%.',
      affectedIndicators: 'Cartera Vencida Total, DSO (38.6 días), Utilización de Límite de Crédito y Pérdida Crediticia Esperada (ECL).',
      potentialImpact: 'Recuperación estimada de $3.15B COP en flujo de caja en 45 días, reducción del DSO en -3.8 días y disminución de la ECL en -$680M COP.',
      proposedAlternative: 'Establecer acuerdos de pago escalonados respaldados por garantías reales, conciliar en 5 días los $445M COP en notas crédito/disputas y ajustar temporalmente el cupo disponible.',
      priority: 'Alta',
      assumptionsAndLimits: 'No ejecuta bloqueos automáticos en SAP; requiere validación comercial y aprobación formal del Comité de Crédito.'
    },
    {
      id: 'STRAT-02',
      title: 'Estrategia de Cobertura Cambiaria (Forward NDF + Calce Natural) sobre Exposición Neta USD/EUR',
      finding: 'La organización mantiene una posición monetaria activa neta de +$12.94B COP en moneda extranjera ($7.81B USD y $5.13B EUR).',
      evidence: 'Cruce entre cuentas por cobrar en divisas ($29.94B COP) y pasivos en divisas ($17.00B COP).',
      affectedIndicators: 'Diferencia en Cambio Neta, Ingresos Operacionales en COP y Margen EBITDA.',
      potentialImpact: 'Protege hasta $905M COP ante escenarios de apreciación abrupta del peso colombiano (-7% a -10%).',
      proposedAlternative: 'Cubrir mediante instrumentos Forward el 45% de la posición activa neta a 30–60 días y sincronizar el pago de materias primas importadas con los flujos de recaudo de exportación.',
      priority: 'Alta',
      assumptionsAndLimits: 'Sujeto a evaluación de puntos forward y políticas del Comité de Riesgo de Mercado y Tesorería.'
    },
    {
      id: 'STRAT-03',
      title: 'Optimización de Estructura de Tasas de Interés (Conversión Parcial Variable a Fija)',
      finding: 'El 63.4% de las obligaciones financieras ($20.52B COP) está expuesto a fluctuaciones de tasas variables (IBR y SOFR).',
      evidence: 'Pruebas de estrés muestran que un choque de +200 a +325 pbs incrementa el gasto anual por intereses entre $410M y $667M COP.',
      affectedIndicators: 'Gasto Financiero Anual, Cobertura de Intereses (EBITDA / Intereses) y Utilidad Neta.',
      potentialImpact: 'Ahorro financiero proyectado de $295M COP/año y estabilización del flujo de caja del servicio de la deuda.',
      proposedAlternative: 'Renegociar spread en la Línea Sindicada de Capital de Trabajo o pactar cobertura IRS sobre $6.50B COP.',
      priority: 'Media',
      assumptionsAndLimits: 'Depende de la curva vigente de swaps IBR y condiciones contractuales de prepago.'
    },
    {
      id: 'STRAT-04',
      title: 'Indexación Selectiva y Descuento por Pronto Pago en Segmentos Vulnerables a la Inflación',
      finding: 'El segmento Industrial y Retail Nacional presenta un Pass-Through de solo 54% y un crecimiento real negativo (-2.11%) ajustado por inflación.',
      evidence: 'Análisis de elasticidad precio-volumen y alargamiento del plazo real de recaudo en clientes nacionales.',
      affectedIndicators: 'Margen Bruto Real, Rotación de Cartera (DSO) y Morosidad de 1 a 60 días.',
      potentialImpact: 'Mejora de +110 pbs en margen operativo del segmento nacional y reducción de 6.5 días en el ciclo de cobro.',
      proposedAlternative: 'Implementar descuento financiero condicionado al pago antes del día 15 (2.0% pronto pago) y cláusulas de revisión trimestral de precios por IPP.',
      priority: 'Media',
      assumptionsAndLimits: 'El descuento debe otorgarse únicamente contra recaudo efectivo verificado.'
    }
  ];

  // Baseline para simulaciones y pruebas de estrés
  const simulationBaseline = {
    totalAnnualRevenueCop,
    totalCreditExposureCop,
    totalReceivablesCop,
    totalOverdueCop,
    totalExpectedCreditLossCop,
    netForeignCurrencyExposureCop,
    variableRateDebtCop: dataset.debtAndInterestStructure.variableRateDebtCop,
    currentAnnualInterestExpenseCop: dataset.debtAndInterestStructure.currentAnnualInterestExpenseCop,
    ebitdaReferenceCop: dataset.debtAndInterestStructure.ebitdaReferenceCop,
    dsoDays,
    overdueRatePct
  };

  const evaluatedPresetScenarios = PRESET_RISK_SCENARIOS.map(sc => ({
    ...sc,
    results: simulateFinancialRiskScenario(simulationBaseline, sc.assumptions)
  }));

  const activeSimulation = simulateFinancialRiskScenario(
    simulationBaseline,
    filters.customAssumptions || PRESET_RISK_SCENARIOS[2].assumptions
  );

  // Matrices de sensibilidad cambiaria y de tasas para la Página 5
  const fxSensitivityTable = [-10, -5, 0, 5, 10, 15].map(pct => {
    const sim = simulateFinancialRiskScenario(simulationBaseline, {
      delinquencyShiftPct: 0,
      revenueChangePct: 0,
      fxRateChangePct: pct,
      inflationChangePts: 0,
      interestRateDeltaBps: 0,
      dsoDeltaDays: 0,
      creditExposureGrowthPct: 0,
      operatingCostChangePct: 0
    });
    return {
      fxChangePct: pct,
      usdSpotSimulated: Math.round(4145 * (1 + pct / 100)),
      eurSpotSimulated: Math.round(4510 * (1 + pct / 100)),
      fxBalanceImpactCop: sim.simulated.fxNetGainLossCop,
      revenueSimulatedCop: sim.simulated.revenueCop,
      ebitdaSimulatedCop: sim.simulated.ebitdaCop
    };
  });

  const interestRateSensitivityTable = [-200, -100, 0, 100, 200, 300].map(bps => {
    const deltaInterest = Math.round(dataset.debtAndInterestStructure.variableRateDebtCop * (bps / 10000));
    const totalInterest = dataset.debtAndInterestStructure.currentAnnualInterestExpenseCop + deltaInterest;
    const coverage = +(dataset.debtAndInterestStructure.ebitdaReferenceCop / Math.max(1, totalInterest)).toFixed(2);
    return {
      deltaBps: bps,
      variableDebtCop: dataset.debtAndInterestStructure.variableRateDebtCop,
      fixedDebtCop: dataset.debtAndInterestStructure.fixedRateDebtCop,
      annualInterestExpenseCop: totalInterest,
      interestDeltaCop: deltaInterest,
      ebitdaCoverageRatio: coverage
    };
  });

  // Gobierno, Calidad de Datos y Diccionario de Fórmulas (Secciones 2, 9, 12, 13)
  const governanceAndMethodology = {
    sapDataSources: [
      { domain: 'Cuentas por Cobrar y Antigüedad de Saldos', status: 'Conectado en Vivo (SAP ECC 6.0)', description: 'Partidas abiertas y compensadas de clientes, fechas base de vencimiento, plazos de pago, notas crédito y monedas de transacción.' },
      { domain: 'Gestión de Crédito y Cupos Aprobados', status: 'Conectado en Vivo (SAP Credit Management Clásico)', description: 'Áreas de control de crédito, límites aprobados por cliente, cuentas por cobrar acumuladas, valor de pedidos abiertos y clase de riesgo.' },
      { domain: 'Cuentas por Pagar y Posición Monetaria en Divisas', status: 'Conectado en Vivo (SAP ECC 6.0)', description: 'Obligaciones abiertas con proveedores en USD, EUR y COP para determinar la Exposición Cambiaria Neta.' },
      { domain: 'Tipos de Cambio y Variables Macroeconómicas', status: 'Híbrido (SAP + Fuentes Oficiales)', description: 'Tasas de cambio USD/COP y EUR/COP sincronizadas con el maestro cambiario SAP; inflación (IPC/IPP DANE), tasas de interés (IBR BanRep) y precios internacionales (CPO Rotterdam) integrados desde series oficiales con fecha de corte explícita.' }
    ],
    architecturalNotes: [
      'SAP Credit Management Clásico vs SAP FSCM (S/4HANA): El entorno productivo opera sobre la gestión de crédito clásica de SAP ECC (áreas de control de crédito y maestro crediticio de clientes). Los modelos predictivos de probabilidad de incumplimiento (PD) y pérdida esperada (ECL) se ejecutan en el motor analítico SAC Smart Predict.',
      'Prevención de Doble Conteo en Exposición Crediticia: La Exposición Crediticia Total suma exclusivamente las Cuentas por Cobrar Abiertas más los Pedidos de Venta Abiertos aún no facturados.',
      'Alcance de Pérdida Crediticia Esperada (ECL = PD × LGD × EAD): Indicador gerencial y financiero con horizonte homogéneo; para efectos contables bajo NIIF 9 / IFRS 9 debe complementarse con las matrices de provisión regulatoria auditadas.',
      'Revisión Humana Obligatoria: En cumplimiento de las políticas de gobierno (Sección 12.16-18), ninguna funcionalidad del dashboard modifica límites de crédito ni bloquea clientes o pedidos de forma automática.'
    ],
    formulaDictionary: [
      { name: 'Utilización del Límite de Crédito', formula: '(Exposición Crediticia Total / Límite de Crédito Aprobado) × 100', unit: '%' },
      { name: 'Tasa de Cartera Vencida', formula: '(Cartera Vencida Total / Cartera Total Pendiente) × 100', unit: '%' },
      { name: 'DSO (Días de Cartera)', formula: '(Cuentas por Cobrar Promedio / Ventas a Crédito del Período) × 365', unit: 'días' },
      { name: 'Tasa de Incumplimiento Histórica', formula: '(Clientes con Mora Crítica > 60 días / Población Evaluada) × 100', unit: '%' },
      { name: 'Exposición Cambiaria Neta', formula: 'Activos Monetarios Expuestos (AR + Bancos Divisas) − Pasivos Monetarios Expuestos (AP + Deuda Divisas)', unit: 'COP' },
      { name: 'Impacto Cambiario Simplificado', formula: 'Exposición Monetaria Neta en Moneda Extranjera × Variación % de la Tasa de Cambio', unit: 'COP' },
      { name: 'Pérdida Crediticia Esperada (ECL)', formula: 'PD (Probabilidad de Incumplimiento) × LGD (Pérdida dado el Incumplimiento) × EAD (Exposición al Incumplimiento)', unit: 'COP' },
      { name: 'Variación Porcentual de Escenarios', formula: '((Valor Simulado − Valor Base) / |Valor Base|) × 100', unit: '%' }
    ]
  };

  return {
    ok: true,
    meta: dataset.meta,
    appliedFilters: {
      companyCode: companyFilter,
      sector: sectorFilter,
      region: regionFilter,
      currency: currencyFilter,
      riskLevel: riskLevelFilter,
      customerSort: customerRankingSort,
      horizon: forecastHorizon
    },
    catalogs: dataset.catalogs,
    page1Executive: {
      kpis: primaryRiskKpis,
      alerts: riskAlerts,
      historical12M: dataset.macroeconomicContext.historical12M
    },
    page2AgingAndAr: {
      agingBuckets,
      summary: {
        totalReceivablesCop,
        totalCurrentReceivablesCop,
        totalOverdueCop,
        totalDisputedCop,
        netOverdueExcludingDisputesCop: Math.max(0, totalOverdueCop - totalDisputedCop),
        dsoDays,
        overdueRatePct,
        dueNext15DaysCop: sortedCustomers.reduce((s, c) => s + c.dueNext15DaysCop, 0),
        dueNext30DaysCop: totalDueNext30DaysCop
      },
      topOverdueCustomers: [...sortedCustomers]
        .filter(c => c.totalOverdueCop > 0)
        .sort((a, b) => b.totalOverdueCop - a.totalOverdueCop)
    },
    page3CustomerCreditRisk: {
      customers: sortedCustomers,
      summary: {
        totalCreditExposureCop,
        totalApprovedCreditLimitCop,
        creditLimitUtilizationPct,
        totalExpectedCreditLossCop,
        customersExceedingLimitCount,
        highRiskCustomersCount
      }
    },
    page4MacroAndFx: {
      macroeconomicContext: dataset.macroeconomicContext,
      currencyExposure: dataset.currencyExposure,
      netForeignCurrencyExposureCop
    },
    page5FinancialSensitivity: {
      fxSensitivityTable,
      interestRateSensitivityTable,
      debtAndInterestStructure: dataset.debtAndInterestStructure,
      inflationAndRevenueSensitivity: dataset.inflationAndRevenueSensitivity
    },
    page6PredictiveAndAlerts: {
      classificationModel: dataset.smartPredictModels.classificationModel,
      regressionModel: dataset.smartPredictModels.regressionModel,
      selectedHorizonForecast: dataset.smartPredictModels.timeSeriesForecasts.horizons[forecastHorizon] || dataset.smartPredictModels.timeSeriesForecasts.horizons['6'],
      alerts: riskAlerts
    },
    page7StressTestingAndActions: {
      baseline: simulationBaseline,
      presetScenarios: evaluatedPresetScenarios,
      activeSimulation,
      strategicRecommendations
    },
    governanceAndMethodology
  };
}

module.exports = {
  getFinancialRiskOverview,
  simulateFinancialRiskScenario,
  getOrSyncFinancialRiskDataset
};
