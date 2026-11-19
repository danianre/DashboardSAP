const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// Cuentas técnicas de comunicación conocidas en SAP (tipo C / RFC)
const KNOWN_COMMUNICATION_USERS = new Set([
  'CSMREG', 'CONEXION', 'SAPCPIC', 'DHR', 'INT_ODATA', 'WSCON_MM', 'USERLOG', 'SPOLO', 'SAPO', 'TIMESOFT'
]);

function isCommunicationUser(bname, userType) {
  const uname = String(bname || '').toUpperCase().trim();
  if (KNOWN_COMMUNICATION_USERS.has(uname)) return true;
  const type = String(userType || '').toUpperCase().trim();
  if (type === 'C' || type === 'RFC' || type.includes('COMUNIC') || type.includes('COMMUNIC')) return true;
  return false;
}

function prepareCache() {
  console.log('Reading Reporte_Transacciones_No_Usadas_SAP.xlsx...');
  const wb = XLSX.readFile('Reporte_Transacciones_No_Usadas_SAP.xlsx');
  
  // Sheet 1: Resumen Usuarios (excluyendo usuarios de comunicación)
  const ws1 = wb.Sheets['Resumen Usuarios'];
  const allUserSummaries = XLSX.utils.sheet_to_json(ws1);
  const userSummaries = allUserSummaries.filter(u => !isCommunicationUser(u['Usuario (BNAME)'], u['Tipo Usuario']));
  
  // Sheet 2: Roles 100% Sin Uso (excluyendo usuarios de comunicación)
  const ws2 = wb.Sheets['Roles 100% Sin Uso'];
  const allZeroRoles = XLSX.utils.sheet_to_json(ws2);
  const zeroRoles = allZeroRoles.filter(r => !isCommunicationUser(r['Usuario (BNAME)']));

  console.log(`Total usuarios (sin comunicación): ${userSummaries.length} (original: ${allUserSummaries.length})`);
  console.log(`Total roles sin uso (sin comunicación): ${zeroRoles.length} (original: ${allZeroRoles.length})`);

  // Mapear por usuario
  const usersMap = {};

  userSummaries.forEach(u => {
    const bname = u['Usuario (BNAME)'];
    usersMap[bname] = {
      username: bname,
      fullName: u['Nombre Completo'] || bname,
      userType: u['Tipo Usuario'] || 'Diálogo',
      assignedRolesCount: u['Roles Asignados'] || 0,
      zeroRoles90Count: u['Roles 100% Sin Uso (>90d)'] || 0,
      zeroRoles180Count: u['Roles 100% Sin Uso (>180d)'] || 0,
      redundantRolesCount: u['Roles Redundantes (Solapados)'] || 0,
      lastLogin: u['Último Login'] || '--',
      auditStatus: u['Estado de Auditoría'] || 'Normal',
      roles90: [],
      roles180: []
    };
  });

  zeroRoles.forEach(r => {
    const bname = r['Usuario (BNAME)'];
    if (!usersMap[bname]) {
      usersMap[bname] = {
        username: bname,
        fullName: r['Nombre Completo'] || bname,
        userType: 'Diálogo',
        assignedRolesCount: 0,
        zeroRoles90Count: 0,
        zeroRoles180Count: 0,
        redundantRolesCount: 0,
        lastLogin: '--',
        auditStatus: 'Pendiente',
        roles90: [],
        roles180: []
      };
    }

    const roleName = r['Rol Asignado (AGR_NAME)'];
    const totalTcodes = r['Total TCodes en el Rol'] || 0;
    const isUnused180 = String(r['>180 días (Sin uso)']).includes('Sí');

    const roleObj = {
      role: roleName,
      totalTcodes,
      sharedWithOtherRoles: r['TCodes Compartidas con Otros Roles del Usuario'] || 0,
      exclusiveToRole: r['TCodes Exclusivas de este Rol'] || 0,
      isUnused180,
      action: r['Acción Sugerida'] || (isUnused180 ? 'Remover Rol (Inactivo >180d)' : 'Validar Cierre/Proceso Semestral')
    };

    // Todos los registros de la Hoja 2 están sin uso en >90 días
    usersMap[bname].roles90.push(roleObj);
    if (isUnused180) {
      usersMap[bname].roles180.push(roleObj);
    }
  });

  // Convertir a array y filtrar usuarios que tienen al menos 1 rol a eliminar (sin usuarios de comunicación)
  const allUsersList = Object.values(usersMap);
  const usersWithRemovals = allUsersList.filter(u => (u.roles90.length > 0 || u.roles180.length > 0) && !isCommunicationUser(u.username, u.userType));

  // Ordenar por cantidad de roles a eliminar en 180d descendente
  usersWithRemovals.sort((a, b) => b.roles180.length - a.roles180.length || b.roles90.length - a.roles90.length);

  const payload = {
    generatedAt: new Date().toISOString(),
    system: {
      sid: 'BOP',
      client: '300',
      host: '10.0.0.100'
    },
    metrics: {
      totalActiveUsers: userSummaries.length,
      usersWithZeroRoles90: usersWithRemovals.filter(u => u.roles90.length > 0).length,
      usersWithZeroRoles180: usersWithRemovals.filter(u => u.roles180.length > 0).length,
      totalRolesToRemove90: zeroRoles.length,
      totalRolesToRemove180: zeroRoles.filter(r => String(r['>180 días (Sin uso)']).includes('Sí')).length,
      totalRolesSeasonalValidation: zeroRoles.filter(r => !String(r['>180 días (Sin uso)']).includes('Sí')).length
    },
    users: usersWithRemovals
  };

  const outDir = path.resolve('data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const targetPath = path.join(outDir, 'unused_roles_audit.json');
  fs.writeFileSync(targetPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`Saved audit cache to: ${targetPath}`);

  // Mirror en apps-sap/data si existe
  const appsSapDir = path.resolve('apps-sap', 'data');
  if (fs.existsSync(appsSapDir)) {
    const appsSapTarget = path.join(appsSapDir, 'unused_roles_audit.json');
    fs.writeFileSync(appsSapTarget, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`Mirrored audit cache to: ${appsSapTarget}`);
  }

  console.log('Metrics:', payload.metrics);
}

prepareCache();
