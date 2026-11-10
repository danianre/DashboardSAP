const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { executeRfc } = require('../config/sap');

async function rfcWithRetry(fnName, params, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await executeRfc(fnName, params);
    } catch (err) {
      console.warn(`   [Retry ${i + 1}/${retries}] Error en ${fnName}: ${err.key || err.message}`);
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

async function buildExcelReportV2() {
  const startTime = Date.now();
  console.log('=== INICIANDO AUDITORÍA AVANZADA DE ROLES Y TRANSACCIONES (90 Y 180 DÍAS + USO INDIRECTO + SOLAPAMIENTO) ===');

  // 1. Cargar usuarios activos
  const users = JSON.parse(fs.readFileSync('scripts/active_users_dump.json', 'utf8'));
  console.log(`1. Usuarios activos cargados: ${users.length}`);

  // 2. Consultar jerarquía de roles compuestos (AGR_AGRS)
  console.log('2. Consultando jerarquía de roles compuestos (AGR_AGRS)...');
  const resAgrAgrs = await rfcWithRetry('RFC_READ_TABLE', {
    QUERY_TABLE: 'AGR_AGRS',
    DELIMITER: '|',
    FIELDS: [{ FIELDNAME: 'AGR_NAME' }, { FIELDNAME: 'CHILD_AGR' }]
  });
  const childRolesByParent = {};
  resAgrAgrs.DATA.forEach(r => {
    const parts = r.WA.split('|').map(s => s.trim());
    if (!childRolesByParent[parts[0]]) childRolesByParent[parts[0]] = [];
    childRolesByParent[parts[0]].push(parts[1]);
  });

  // 3. Consultar transacciones de menú por rol (AGR_TCODES) y de objeto S_TCODE (AGR_1251)
  console.log('3. Consultando transacciones por rol en menú (AGR_TCODES) y autorizaciones (AGR_1251 S_TCODE)...');
  const resAgrTcodes = await rfcWithRetry('RFC_READ_TABLE', {
    QUERY_TABLE: 'AGR_TCODES',
    DELIMITER: '|',
    FIELDS: [{ FIELDNAME: 'AGR_NAME' }, { FIELDNAME: 'TCODE' }]
  });
  const tcodesByRole = {};
  const menuTcodesByRole = {};
  resAgrTcodes.DATA.forEach(r => {
    const parts = r.WA.split('|').map(s => s.trim());
    const role = parts[0];
    const tcode = parts[1].toUpperCase();
    if (!tcode || tcode.includes('*')) return;
    if (!tcodesByRole[role]) tcodesByRole[role] = new Set();
    tcodesByRole[role].add(tcode);
    if (!menuTcodesByRole[role]) menuTcodesByRole[role] = new Set();
    menuTcodesByRole[role].add(tcode);
  });

  const resAgr1251 = await rfcWithRetry('RFC_READ_TABLE', {
    QUERY_TABLE: 'AGR_1251',
    DELIMITER: '|',
    FIELDS: [{ FIELDNAME: 'AGR_NAME' }, { FIELDNAME: 'LOW' }, { FIELDNAME: 'HIGH' }],
    OPTIONS: [{ TEXT: "OBJECT = 'S_TCODE' AND DELETED = ' '" }]
  });
  resAgr1251.DATA.forEach(r => {
    const parts = r.WA.split('|').map(s => s.trim());
    const role = parts[0];
    const low = (parts[1] || '').toUpperCase();
    const high = (parts[2] || '').toUpperCase();
    if (low && !low.includes('*') && !high) {
      if (!tcodesByRole[role]) tcodesByRole[role] = new Set();
      tcodesByRole[role].add(low);
    }
  });

  // Expandir roles compuestos
  const allTcodesByRole = {};
  for (const role in tcodesByRole) {
    allTcodesByRole[role] = new Set(tcodesByRole[role]);
  }
  for (const parent in childRolesByParent) {
    if (!allTcodesByRole[parent]) allTcodesByRole[parent] = new Set();
    childRolesByParent[parent].forEach(child => {
      if (tcodesByRole[child]) {
        tcodesByRole[child].forEach(tc => allTcodesByRole[parent].add(tc));
      }
    });
  }
  console.log(` -> Total roles con transacciones mapeadas: ${Object.keys(allTcodesByRole).length}`);

  // 4. Consultar TSTC (Mapeo TCODE <-> Programa ABAP PGMNA)
  console.log('4. Consultando tabla TSTC (Mapeo Transacción <-> Programa ABAP)...');
  const resTstc = await rfcWithRetry('RFC_READ_TABLE', {
    QUERY_TABLE: 'TSTC',
    DELIMITER: '|',
    FIELDS: [{ FIELDNAME: 'TCODE' }, { FIELDNAME: 'PGMNA' }]
  });
  const validTcodes = new Set();
  const tcodesByProgram = {};
  resTstc.DATA.forEach(r => {
    const parts = r.WA.split('|').map(s => s.trim().toUpperCase());
    const tc = parts[0];
    const pgm = parts[1];
    if (tc) validTcodes.add(tc);
    if (tc && pgm) {
      if (!tcodesByProgram[pgm]) tcodesByProgram[pgm] = new Set();
      tcodesByProgram[pgm].add(tc);
    }
  });
  console.log(` -> Transacciones válidas en TSTC: ${validTcodes.size} | Programas vinculados: ${Object.keys(tcodesByProgram).length}`);

  // 5. Consultar TCDCOUPLES (SE97 - Transacciones llamadas desde otras transacciones)
  console.log('5. Consultando tabla TCDCOUPLES (SE97 - Transacciones invocadas desde otras transacciones)...');
  const resCouples = await rfcWithRetry('RFC_READ_TABLE', {
    QUERY_TABLE: 'TCDCOUPLES',
    DELIMITER: '|',
    FIELDS: [{ FIELDNAME: 'TCODE' }, { FIELDNAME: 'CALLED' }]
  });
  const calledByCaller = {};
  resCouples.DATA.forEach(r => {
    const parts = r.WA.split('|').map(s => s.trim().toUpperCase());
    const caller = parts[0];
    const called = parts[1];
    if (caller && called && caller !== called) {
      if (!calledByCaller[caller]) calledByCaller[caller] = new Set();
      calledByCaller[caller].add(called);
    }
  });
  console.log(` -> Transacciones madre que llaman a otras en SE97: ${Object.keys(calledByCaller).length}`);

  // 6. Consultar textos de transacciones (TSTCT)
  console.log('6. Consultando descripciones de transacciones en español (TSTCT)...');
  const resTstct = await rfcWithRetry('RFC_READ_TABLE', {
    QUERY_TABLE: 'TSTCT',
    DELIMITER: '|',
    FIELDS: [{ FIELDNAME: 'TCODE' }, { FIELDNAME: 'TTEXT' }],
    OPTIONS: [{ TEXT: "SPRSL = 'S'" }]
  });
  const tcodeTexts = {};
  resTstct.DATA.forEach(r => {
    const parts = r.WA.split('|').map(s => s.trim());
    tcodeTexts[parts[0].toUpperCase()] = parts[1];
  });

  // 7. Extraer telemetría 0-90 días (ST03N / SWNC_COLLECTOR_GET_AGGREGATES: Sept, Oct, Nov 2026)
  console.log('7. Extrayendo telemetría 0-90 días (ST03N: Septiembre, Octubre, Noviembre 2026)...');
  const directUsed90d = {};
  const programUsed90d = {};
  const indirectUsed90d = {};

  const periods90d = ['20261101', '20261001', '20260901'];
  for (const period of periods90d) {
    const resAgg = await rfcWithRetry('SWNC_COLLECTOR_GET_AGGREGATES', {
      COMPONENT: 'TOTAL',
      PERIODTYPE: 'M',
      PERIODSTRT: period
    });
    if (resAgg.USERTCODE) {
      resAgg.USERTCODE.forEach(entry => {
        const uname = entry.ACCOUNT.trim();
        const rawId = entry.ENTRY_ID;
        const cleanName = rawId.slice(0, 70).trim().toUpperCase();
        const entryType = rawId.slice(70).trim().toUpperCase();
        if (!cleanName) return;

        if (!directUsed90d[uname]) directUsed90d[uname] = new Set();
        if (!programUsed90d[uname]) programUsed90d[uname] = new Set();

        if (entryType === 'T' || validTcodes.has(cleanName)) {
          directUsed90d[uname].add(cleanName);
        }
        if (tcodesByProgram[cleanName]) {
          tcodesByProgram[cleanName].forEach(tc => programUsed90d[uname].add(tc));
        }
      });
    }
  }

  for (const uname of Object.keys(directUsed90d)) {
    indirectUsed90d[uname] = new Map();
    const activeDirect = directUsed90d[uname];
    activeDirect.forEach(callerTc => {
      if (calledByCaller[callerTc]) {
        calledByCaller[callerTc].forEach(calledTc => {
          if (!activeDirect.has(calledTc) && !indirectUsed90d[uname].has(calledTc)) {
            indirectUsed90d[uname].set(calledTc, callerTc);
          }
        });
      }
    });
  }

  // 8. Extraer evidencia histórica 91-180 días (Mayo 14 a Agosto 31 de 2026) por lotes mensuales cortos
  console.log('8. Extrayendo actividad histórica de 91 a 180 días (Mayo a Agosto 2026 en bloques mensuales)...');
  const used91to180d = {};
  function add180d(uname, tc) {
    if (!uname || !tc) return;
    const u = uname.trim();
    const t = tc.trim().toUpperCase();
    if (!t) return;
    if (!used91to180d[u]) used91to180d[u] = new Set();
    used91to180d[u].add(t);
  }

  const monthRanges = [
    { label: 'Mayo 2026', start: '20260514', end: '20260531' },
    { label: 'Junio 2026', start: '20260601', end: '20260630' },
    { label: 'Julio 2026', start: '20260701', end: '20260731' },
    { label: 'Agosto 2026', start: '20260801', end: '20260831' }
  ];

  for (const m of monthRanges) {
    console.log(` -> Procesando ${m.label} (CDHDR, BKPF, MKPF)...`);
    // CDHDR
    const resCd = await rfcWithRetry('RFC_READ_TABLE', {
      QUERY_TABLE: 'CDHDR',
      DELIMITER: '|',
      FIELDS: [{ FIELDNAME: 'USERNAME' }, { FIELDNAME: 'TCODE' }],
      OPTIONS: [{ TEXT: `UDATE >= '${m.start}' AND UDATE <= '${m.end}'` }]
    });
    resCd.DATA.forEach(r => {
      const p = r.WA.split('|');
      add180d(p[0], p[1]);
    });

    // BKPF
    const resBk = await rfcWithRetry('RFC_READ_TABLE', {
      QUERY_TABLE: 'BKPF',
      DELIMITER: '|',
      FIELDS: [{ FIELDNAME: 'USNAM' }, { FIELDNAME: 'TCODE' }],
      OPTIONS: [{ TEXT: `CPUDT >= '${m.start}' AND CPUDT <= '${m.end}'` }]
    });
    resBk.DATA.forEach(r => {
      const p = r.WA.split('|');
      add180d(p[0], p[1]);
    });

    // MKPF
    const resMk = await rfcWithRetry('RFC_READ_TABLE', {
      QUERY_TABLE: 'MKPF',
      DELIMITER: '|',
      FIELDS: [{ FIELDNAME: 'USNAM' }, { FIELDNAME: 'TCODE2' }],
      OPTIONS: [{ TEXT: `CPUDT >= '${m.start}' AND CPUDT <= '${m.end}'` }]
    });
    resMk.DATA.forEach(r => {
      const p = r.WA.split('|');
      add180d(p[0], p[1]);
    });
  }

  // Propagar llamadas indirectas TCDCOUPLES sobre lo usado en 91-180d
  for (const uname of Object.keys(used91to180d)) {
    const baseSet = new Set(used91to180d[uname]);
    baseSet.forEach(callerTc => {
      if (calledByCaller[callerTc]) {
        calledByCaller[callerTc].forEach(calledTc => used91to180d[uname].add(calledTc));
      }
    });
  }

  console.log(` -> Usuarios con actividad histórica registrada en ventana 91-180 días: ${Object.keys(used91to180d).length}`);

  // 9. Construir hojas del Excel considerando solapamiento entre roles y llamadas desde otras transacciones
  console.log('9. Procesando cruce de roles, solapamiento de transacciones y llamadas internas...');

  const sheet1Data = [
    [
      'Usuario (BNAME)',
      'Nombre Completo',
      'Tipo Usuario',
      'Roles Asignados',
      'Roles 100% Sin Uso (>90d)',
      'Roles 100% Sin Uso (>180d)',
      'Roles Redundantes (Solapados)',
      'TCodes Únicas Autorizadas',
      'TCodes Usadas Directas (90d)',
      'TCodes Usadas Indirectas / Internas (SE97 / Prog)',
      'TCodes Sin Uso Real (GAP Único)',
      'TCodes Repetidas en Varios Roles',
      '% Inactividad Real (Contando Indirectas)',
      'Último Login',
      'Estado de Auditoría',
      'Acción Recomendada'
    ]
  ];

  const sheet2Data = [
    [
      'Usuario (BNAME)',
      'Nombre Completo',
      'Rol Asignado (AGR_NAME)',
      'Total TCodes en el Rol',
      'TCodes Compartidas con Otros Roles del Usuario',
      'TCodes Exclusivas de este Rol',
      'TCodes Usadas Directas (90d)',
      'TCodes Usadas desde Otras TCodes / Prog (90d)',
      '>90 días (Sin uso)',
      '>180 días (Sin uso)',
      'Tipo de Hallazgo en el Rol',
      'Acción Sugerida'
    ]
  ];

  const sheet3Data = [
    [
      'Usuario (BNAME)',
      'Nombre Completo',
      'Rol Asignado (AGR_NAME)',
      'Código Transacción (TCODE)',
      'Descripción de la Transacción',
      'Origen en el Rol (Menú / S_TCODE)',
      'Cant. Roles del Usuario que tienen esta TCode',
      '¿Repetida en Otros Roles del Usuario?',
      'Otros Roles donde se repite (Muestra)',
      '>90 días (Sin uso)',
      '>180 días (Sin uso)',
      'Estado de Uso (Directo / Indirecto)'
    ]
  ];

  function formatSapDate(d) {
    if (!d || d === '00000000') return 'Nunca / Sin login';
    return `${d.substring(6, 8)}/${d.substring(4, 6)}/${d.substring(0, 4)}`;
  }

  let totalZero90Roles = 0;
  let totalZero180Roles = 0;
  let totalRedundantRoles = 0;
  let totalIndirectProtectedTcodes = 0;

  users.forEach(u => {
    const uname = u.bname;
    const assignedRoles = u.roles || [];

    const directSet90 = directUsed90d[uname] || new Set();
    const progSet90 = programUsed90d[uname] || new Set();
    const indirectMap90 = indirectUsed90d[uname] || new Map();
    const histSet180 = used91to180d[uname] || new Set();

    const rolesContainingTcode = {};
    assignedRoles.forEach(role => {
      const rTcodes = allTcodesByRole[role] || new Set();
      rTcodes.forEach(tc => {
        if (!rolesContainingTcode[tc]) rolesContainingTcode[tc] = [];
        rolesContainingTcode[tc].push(role);
      });
    });

    const allUniqueUserTcodes = Object.keys(rolesContainingTcode);
    let uniqueDirectCount = 0;
    let uniqueIndirectCount = 0;
    let uniqueUnusedCount = 0;
    let duplicatedTcodesCount = 0;

    const tcodeUsageStatus = {};
    allUniqueUserTcodes.forEach(tc => {
      if (rolesContainingTcode[tc].length > 1) duplicatedTcodesCount++;

      const isDirect90 = directSet90.has(tc);
      const isProg90 = !isDirect90 && progSet90.has(tc);
      const isIndirect90 = !isDirect90 && !isProg90 && indirectMap90.has(tc);
      const usedIn90 = isDirect90 || isProg90 || isIndirect90;
      const usedIn180 = usedIn90 || histSet180.has(tc);

      let mode = 'No Utilizada';
      if (isDirect90) {
        uniqueDirectCount++;
        mode = 'Usada Directamente';
      } else if (isProg90) {
        uniqueIndirectCount++;
        totalIndirectProtectedTcodes++;
        mode = 'Usada vía Programa ABAP (ST03N)';
      } else if (isIndirect90) {
        uniqueIndirectCount++;
        totalIndirectProtectedTcodes++;
        mode = `Ingresada desde ${indirectMap90.get(tc)} (SE97)`;
      } else {
        uniqueUnusedCount++;
      }

      tcodeUsageStatus[tc] = {
        isDirect90,
        isIndirectOrProg90: isProg90 || isIndirect90,
        usedIn90,
        usedIn180,
        mode
      };
    });

    let userZero90Roles = 0;
    let userZero180Roles = 0;
    let userRedundantRoles = 0;

    const activeRolesSet = new Set();
    assignedRoles.forEach(role => {
      const rTcodes = allTcodesByRole[role] || new Set();
      let anyUsed90 = false;
      rTcodes.forEach(tc => {
        if (tcodeUsageStatus[tc] && tcodeUsageStatus[tc].usedIn90) anyUsed90 = true;
      });
      if (anyUsed90) activeRolesSet.add(role);
    });

    assignedRoles.forEach(role => {
      const rTcodes = allTcodesByRole[role] || new Set();
      const menuSet = menuTcodesByRole[role] || new Set();
      const totalInRole = rTcodes.size;

      let sharedWithOtherRoles = 0;
      let exclusiveToThisRole = 0;
      let directUsedInRole = 0;
      let indirectUsedInRole = 0;
      let anyUsed180InRole = false;
      let allUsedCoveredByOtherActiveRole = true;

      rTcodes.forEach(tc => {
        const owners = rolesContainingTcode[tc] || [];
        if (owners.length > 1) sharedWithOtherRoles++;
        else exclusiveToThisRole++;

        const st = tcodeUsageStatus[tc];
        if (st.isDirect90) directUsedInRole++;
        if (st.isIndirectOrProg90) indirectUsedInRole++;
        if (st.usedIn180) anyUsed180InRole = true;

        if (st.usedIn90) {
          const otherActiveOwners = owners.filter(o => o !== role && activeRolesSet.has(o));
          if (otherActiveOwners.length === 0) {
            allUsedCoveredByOtherActiveRole = false;
          }
        }
      });

      const totalUsed90InRole = directUsedInRole + indirectUsedInRole;
      const isUnused90 = totalInRole > 0 && totalUsed90InRole === 0;
      const isUnused180 = isUnused90 && !anyUsed180InRole;
      const isRedundantOverlap = totalInRole > 0 && totalUsed90InRole > 0 && allUsedCoveredByOtherActiveRole;

      if (isUnused90) {
        userZero90Roles++;
        totalZero90Roles++;
        if (isUnused180) {
          userZero180Roles++;
          totalZero180Roles++;
        }

        sheet2Data.push([
          uname,
          u.fullName,
          role,
          totalInRole,
          sharedWithOtherRoles,
          exclusiveToThisRole,
          0,
          0,
          'Sí (>90 días sin uso)',
          isUnused180 ? 'Sí (>180 días sin uso)' : 'No (Usado entre 91 y 180 días)',
          isUnused180 ? '100% Sin Uso (>180 días)' : '100% Sin Uso Reciente (>90 días)',
          isUnused180 ? 'Remover Rol (Inactivo >180d)' : 'Validar Cierre/Proceso Semestral antes de Remover'
        ]);
      } else if (isRedundantOverlap) {
        userRedundantRoles++;
        totalRedundantRoles++;
      }

      rTcodes.forEach(tc => {
        const st = tcodeUsageStatus[tc];
        if (!st.usedIn90) {
          const owners = rolesContainingTcode[tc] || [role];
          const otherOwners = owners.filter(o => o !== role);
          const origin = menuSet.has(tc) ? 'Menú + Autorización' : 'Solo Objeto S_TCODE (Interna)';
          const desc = tcodeTexts[tc] || '(Sin descripción estándar)';

          sheet3Data.push([
            uname,
            u.fullName,
            role,
            tc,
            desc,
            origin,
            owners.length,
            owners.length > 1 ? `Sí (En ${owners.length} roles)` : 'No (Único rol)',
            otherOwners.length > 0 ? otherOwners.slice(0, 4).join(', ') + (otherOwners.length > 4 ? '...' : '') : '-',
            'Sí (>90 días sin uso)',
            !st.usedIn180 ? 'Sí (>180 días sin uso)' : 'No (Usada entre 91 y 180d)',
            !st.usedIn180 ? 'No Utilizada (>180d)' : 'No Utilizada en 90d (Usada en 91-180d)'
          ]);
        }
      });
    });

    const totalAuth = allUniqueUserTcodes.length;
    const pctInactive = totalAuth > 0 ? ((uniqueUnusedCount / totalAuth) * 100).toFixed(1) : '0.0';

    let auditStatus = 'Normal';
    let actionRec = 'Mantener esquema actual';
    if (totalAuth > 0 && parseFloat(pctInactive) >= 90) {
      auditStatus = 'Crítico (≥90% sin uso)';
      actionRec = `Remover ${userZero180Roles} roles >180d y evaluar ${userRedundantRoles} roles solapados`;
    } else if (totalAuth > 0 && parseFloat(pctInactive) >= 70) {
      auditStatus = 'Alto Riesgo (70-89% sin uso)';
      actionRec = `Remover ${userZero180Roles} roles sin uso (>180d)`;
    } else if (userZero90Roles > 0) {
      auditStatus = 'Moderado';
      actionRec = 'Retirar roles inactivos específicos';
    }

    sheet1Data.push([
      uname,
      u.fullName,
      u.ustyp === 'A' ? 'Diálogo' : (u.ustyp === 'B' ? 'Batch' : (u.ustyp === 'C' ? 'RFC' : 'Servicio')),
      assignedRoles.length,
      userZero90Roles,
      userZero180Roles,
      userRedundantRoles,
      totalAuth,
      uniqueDirectCount,
      uniqueIndirectCount,
      uniqueUnusedCount,
      duplicatedTcodesCount,
      `${pctInactive}%`,
      formatSapDate(u.trdat),
      auditStatus,
      actionRec
    ]);
  });

  const summaryStats = {
    totalZero90Roles,
    totalZero180Roles,
    totalRedundantRoles,
    totalIndirectProtectedTcodes,
    sheet3Rows: sheet3Data.length - 1
  };
  fs.writeFileSync('scripts/v2_stats.json', JSON.stringify(summaryStats, null, 2));

  console.log('\n=== RESUMEN DE MÉTRICAS ACTUALIZADAS ===');
  console.log(` - Roles 100% sin uso (>90 días): ${totalZero90Roles}`);
  console.log(` - Roles 100% sin uso (>180 días): ${totalZero180Roles}`);
  console.log(` - Roles con uso pero 100% redundantes (cubiertos por otros roles del usuario): ${totalRedundantRoles}`);
  console.log(` - Transacciones protegidas por uso indirecto (SE97 / Programa ABAP): ${totalIndirectProtectedTcodes}`);
  console.log(` - Total filas Hoja 3 (Detalle TCodes No Usadas): ${sheet3Data.length - 1}`);

  console.log('\n10. Generando libro Excel (.xlsx)...');
  const wb = XLSX.utils.book_new();

  const ws1 = XLSX.utils.aoa_to_sheet(sheet1Data);
  XLSX.utils.book_append_sheet(wb, ws1, 'Resumen Usuarios');

  const ws2 = XLSX.utils.aoa_to_sheet(sheet2Data);
  XLSX.utils.book_append_sheet(wb, ws2, 'Roles 100% Sin Uso');

  const ws3 = XLSX.utils.aoa_to_sheet(sheet3Data);
  XLSX.utils.book_append_sheet(wb, ws3, 'Detalle TCodes No Usadas');

  const localExcelPath = path.resolve('Reporte_Transacciones_No_Usadas_SAP.xlsx');
  const artifactExcelPath = path.join(
    process.env.USERPROFILE,
    '.gemini',
    'antigravity',
    'brain',
    '7794c5f7-fdc6-489f-83ed-217b46215b18',
    'Reporte_Transacciones_No_Usadas_SAP.xlsx'
  );

  XLSX.writeFile(wb, localExcelPath);
  fs.copyFileSync(localExcelPath, artifactExcelPath);

  const stats = fs.statSync(localExcelPath);
  console.log(`\n¡Completado! Excel actualizado (${(stats.size / (1024 * 1024)).toFixed(2)} MB) en ${((Date.now() - startTime) / 1000).toFixed(1)} s.`);
}

buildExcelReportV2().catch(console.error);
