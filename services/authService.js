const crypto = require('crypto');
const { SAP_CONFIG, verifySapCredentials } = require('../config/sap');
const { db } = require('./snapshotService');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas de vigencia de sesión
const sessionsCache = new Map();

// ==========================================
// CONTROL DE ACCESO / LISTA BLANCA (WHITELIST)
// Administradores autorizados para ver y modificar la lista: DREDONDO, HPEREZ
// Usuarios con acceso autorizado por defecto: DREDONDO, HPEREZ, JCUESTA, JANDRADE, SISTEMAS, CONEXION
// ==========================================
const WHITELIST_ADMINS = Object.freeze(['DREDONDO', 'HPEREZ']);
const INITIAL_WHITELIST = Object.freeze(['DREDONDO', 'HPEREZ', 'JCUESTA', 'JANDRADE', 'SISTEMAS', 'CONEXION']);

const whitelistCache = new Set();
let whitelistLoaded = false;

// Inicializar tablas de sesiones y de lista blanca en SQLite
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS sap_auth_sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    client TEXT NOT NULL,
    sysid TEXT,
    host TEXT,
    auth_mode TEXT,
    login_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`);

  // Limpiar sesiones expiradas al iniciar
  db.run(`DELETE FROM sap_auth_sessions WHERE expires_at < ?`, [Date.now()]);

  // Tabla de usuarios autorizados para ingresar al Monitor SAP
  db.run(`CREATE TABLE IF NOT EXISTS sap_monitor_whitelist (
    username TEXT PRIMARY KEY,
    added_by TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    notes TEXT
  )`);

  // Poblar usuarios iniciales garantizando que existan sin sobrescribir si ya fueron personalizados
  const now = Date.now();
  const stmt = db.prepare(`INSERT OR IGNORE INTO sap_monitor_whitelist (username, added_by, added_at, notes) VALUES (?, ?, ?, ?)`);
  INITIAL_WHITELIST.forEach((user) => {
    const isAdmin = WHITELIST_ADMINS.includes(user);
    stmt.run([user, 'SISTEMA_INICIAL', now, isAdmin ? 'Administrador de acceso' : 'Operador autorizado SAP']);
  });
  stmt.finalize();

  // Precargar lista blanca en memoria
  db.all(`SELECT username FROM sap_monitor_whitelist`, (err, rows) => {
    if (!err && Array.isArray(rows)) {
      whitelistCache.clear();
      rows.forEach(r => whitelistCache.add(r.username.toUpperCase()));
      whitelistLoaded = true;
    }
  });
});

function isWhitelistAdmin(username) {
  if (!username) return false;
  return WHITELIST_ADMINS.includes(String(username).trim().toUpperCase());
}

async function isUserWhitelisted(username) {
  if (!username) return false;
  const clean = String(username).trim().toUpperCase();

  if (!whitelistLoaded) {
    await new Promise((resolve) => {
      db.all(`SELECT username FROM sap_monitor_whitelist`, (err, rows) => {
        if (!err && Array.isArray(rows)) {
          whitelistCache.clear();
          rows.forEach(r => whitelistCache.add(r.username.toUpperCase()));
          whitelistLoaded = true;
        }
        resolve();
      });
    });
  }

  return whitelistCache.has(clean);
}

function getWhitelist() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT username, added_by, added_at, notes FROM sap_monitor_whitelist ORDER BY added_at ASC`, (err, rows) => {
      if (err) return reject(err);
      const list = (rows || []).map(r => ({
        username: r.username.toUpperCase(),
        addedBy: r.added_by,
        addedAt: r.added_at,
        notes: r.notes || '',
        isAdmin: WHITELIST_ADMINS.includes(r.username.toUpperCase())
      }));
      resolve(list);
    });
  });
}

function addToWhitelist(username, addedBy, notes = '') {
  return new Promise((resolve, reject) => {
    const cleanUser = String(username || '').trim().toUpperCase();
    const cleanAddedBy = String(addedBy || 'ADMIN').trim().toUpperCase();
    const cleanNotes = String(notes || '').trim();

    if (!cleanUser || cleanUser.length < 2) {
      const err = new Error('El nombre de usuario SAP no puede estar vacío.');
      err.statusCode = 400;
      return reject(err);
    }

    const now = Date.now();
    db.run(
      `INSERT INTO sap_monitor_whitelist (username, added_by, added_at, notes)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(username) DO UPDATE SET added_by = excluded.added_by, added_at = excluded.added_at, notes = excluded.notes`,
      [cleanUser, cleanAddedBy, now, cleanNotes],
      async function(err) {
        if (err) return reject(err);
        whitelistCache.add(cleanUser);
        const list = await getWhitelist();
        resolve(list);
      }
    );
  });
}

function removeFromWhitelist(username, requestedBy) {
  return new Promise(async (resolve, reject) => {
    const cleanUser = String(username || '').trim().toUpperCase();

    if (WHITELIST_ADMINS.includes(cleanUser)) {
      const err = new Error(`No es posible eliminar al administrador principal '${cleanUser}' de la lista de acceso.`);
      err.statusCode = 400;
      return reject(err);
    }

    db.run(`DELETE FROM sap_monitor_whitelist WHERE username = ?`, [cleanUser], async function(err) {
      if (err) return reject(err);
      whitelistCache.delete(cleanUser);
      const list = await getWhitelist();
      resolve(list);
    });
  });
}

/**
 * Traduce los errores nativos de SAP NetWeaver RFC SDK a mensajes claros en español
 * para el usuario final y el analista Basis.
 */
function translateSapAuthError(err, client) {
  const rawMsg = String(err?.message || err || '').trim();
  const lower = rawMsg.toLowerCase();
  const key = String(err?.key || err?.codeString || '').toUpperCase();

  if (
    lower.includes('name or password is incorrect') ||
    lower.includes('nombre o clave de acceso incorrectos') ||
    lower.includes('password is incorrect') ||
    lower.includes('clave de acceso incorrecta')
  ) {
    return {
      userMessage: `Usuario o contraseña de SAP incorrectos en el mandante ${client}. Verifique sus credenciales de SAP GUI.`,
      sapCode: key || 'RFC_LOGON_FAILURE',
      technicalDetail: rawMsg
    };
  }

  if (
    lower.includes('password logon no longer possible') ||
    lower.includes('too many failed attempts') ||
    lower.includes('demasiados intentos')
  ) {
    return {
      userMessage: 'Cuenta bloqueada en SAP por exceso de intentos fallidos. Utilice la Autogestión de Claves (CADI) o contacte a Basis (SU01).',
      sapCode: key || 'RFC_USER_LOCKED_FAILED_ATTEMPTS',
      technicalDetail: rawMsg
    };
  }

  if (lower.includes('user is locked') || lower.includes('usuario bloqueado') || lower.includes('locked')) {
    return {
      userMessage: 'Su usuario se encuentra bloqueado en SAP (transacción SU01). Contacte al administrador del sistema.',
      sapCode: key || 'RFC_USER_LOCKED',
      technicalDetail: rawMsg
    };
  }

  if (
    lower.includes('validity period') ||
    lower.includes('validez') ||
    lower.includes('expired') ||
    lower.includes('no longer valid')
  ) {
    return {
      userMessage: 'Su cuenta de usuario SAP se encuentra fuera de su periodo de validez (cuenta expirada en SU01).',
      sapCode: key || 'RFC_USER_EXPIRED',
      technicalDetail: rawMsg
    };
  }

  if (
    lower.includes('change your password') ||
    lower.includes('initial password') ||
    lower.includes('password must be changed') ||
    lower.includes('modificar la clave')
  ) {
    return {
      userMessage: 'SAP exige cambiar su contraseña inicial o vencida. Por favor ingrese primero por SAP GUI para actualizarla.',
      sapCode: key || 'RFC_PASSWORD_CHANGE_REQUIRED',
      technicalDetail: rawMsg
    };
  }

  if (key === 'RFC_COMMUNICATION_FAILURE' || lower.includes('communication_failure') || lower.includes('partner') || lower.includes('unknown')) {
    return {
      userMessage: `No fue posible establecer comunicación de red con el servidor SAP (${SAP_CONFIG.ashost}) o SAP Router.`,
      sapCode: 'RFC_COMMUNICATION_FAILURE',
      technicalDetail: rawMsg
    };
  }

  return {
    userMessage: `SAP rechazó el inicio de sesión: ${rawMsg.split('\n')[0] || 'Credenciales no válidas'}`,
    sapCode: key || 'RFC_AUTH_ERROR',
    technicalDetail: rawMsg
  };
}

function saveSession(session) {
  sessionsCache.set(session.token, session);
  return new Promise((resolve) => {
    db.run(
      `INSERT OR REPLACE INTO sap_auth_sessions (token, username, client, sysid, host, auth_mode, login_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        session.token,
        session.username,
        session.client,
        session.sysId,
        session.host,
        session.authMode,
        session.loginAt,
        session.expiresAt
      ],
      () => resolve(session)
    );
  });
}

function getSessionByToken(token) {
  if (!token) return Promise.resolve(null);

  const now = Date.now();
  const cached = sessionsCache.get(token);
  if (cached) {
    if (cached.expiresAt > now) {
      return Promise.resolve(cached);
    }
    sessionsCache.delete(token);
  }

  return new Promise((resolve) => {
    db.get(
      `SELECT token, username, client, sysid, host, auth_mode, login_at, expires_at
       FROM sap_auth_sessions
       WHERE token = ?`,
      [token],
      (err, row) => {
        if (err || !row) return resolve(null);
        if (row.expires_at <= now) {
          db.run(`DELETE FROM sap_auth_sessions WHERE token = ?`, [token]);
          return resolve(null);
        }
        const session = {
          token: row.token,
          username: row.username,
          client: row.client,
          sysId: row.sysid,
          host: row.host,
          authMode: row.auth_mode,
          loginAt: row.login_at,
          expiresAt: row.expires_at
        };
        sessionsCache.set(token, session);
        resolve(session);
      }
    );
  });
}

function deleteSession(token) {
  if (!token) return Promise.resolve();
  sessionsCache.delete(token);
  return new Promise((resolve) => {
    db.run(`DELETE FROM sap_auth_sessions WHERE token = ?`, [token], () => resolve());
  });
}

/**
 * Autentica al usuario contra SAP NetWeaver usando sus credenciales de SAP GUI.
 */
async function loginWithSap(username, password, client) {
  const cleanUser = String(username || '').trim();
  const cleanPass = String(password || '');
  const cleanClient = String(client || SAP_CONFIG.client || '300').trim();

  if (!cleanUser || !cleanPass) {
    const err = new Error('Por favor ingrese su usuario y contraseña de SAP.');
    err.statusCode = 400;
    throw err;
  }

  let sapAuthResult = null;

  if (process.env.SAP_LIVE === 'true') {
    try {
      sapAuthResult = await verifySapCredentials(cleanUser, cleanPass, cleanClient);
    } catch (rfcErr) {
      const errKey = String(rfcErr?.key || rfcErr?.codeString || '').toUpperCase();
      const isNetworkOrSdkIssue =
        errKey === 'RFC_COMMUNICATION_FAILURE' ||
        errKey === 'RFC_SDK_MISSING' ||
        String(rfcErr?.message || '').includes('SAPNWRFC') ||
        String(rfcErr?.message || '').includes('libsapnwrfc') ||
        String(rfcErr?.message || '').includes('cannot open shared object file') ||
        String(rfcErr?.message || '').includes('not found');

      // Respaldo de contingencia exclusivamente si el servidor SAP no es alcanzable por red
      // pero el usuario ingresa exactamente las credenciales configuradas en .env
      const matchesEnvCredentials =
        SAP_CONFIG.user &&
        SAP_CONFIG.passwd &&
        cleanUser.toUpperCase() === SAP_CONFIG.user.toUpperCase() &&
        cleanPass === SAP_CONFIG.passwd &&
        cleanClient === (SAP_CONFIG.client || '300');

      if (isNetworkOrSdkIssue && matchesEnvCredentials) {
        sapAuthResult = {
          authenticated: true,
          user: cleanUser.toUpperCase(),
          client: cleanClient,
          sysId: 'BOP',
          host: SAP_CONFIG.ashost || '10.0.0.100',
          mode: 'CONTINGENCIA_LOCAL'
        };
      } else {
        const translated = translateSapAuthError(rfcErr, cleanClient);
        const authError = new Error(translated.userMessage);
        authError.statusCode = 401;
        authError.sapCode = translated.sapCode;
        authError.technicalDetail = translated.technicalDetail;
        throw authError;
      }
    }
  } else {
    // Modo simulación (SAP_LIVE !== 'true')
    if (
      SAP_CONFIG.user &&
      SAP_CONFIG.passwd &&
      (cleanUser.toUpperCase() !== SAP_CONFIG.user.toUpperCase() || cleanPass !== SAP_CONFIG.passwd)
    ) {
      const authError = new Error(`Usuario o contraseña de SAP incorrectos en el mandante ${cleanClient}.`);
      authError.statusCode = 401;
      authError.sapCode = 'SIMULATION_AUTH_FAILED';
      throw authError;
    }

    sapAuthResult = {
      authenticated: true,
      user: cleanUser.toUpperCase(),
      client: cleanClient,
      sysId: 'BOQ',
      host: SAP_CONFIG.ashost || '10.0.0.100',
      mode: 'SIMULACIÓN'
    };
  }

  // 1. Control de Acceso: Verificar si el usuario está en la Lista Blanca (Whitelist)
  const isWhitelisted = await isUserWhitelisted(sapAuthResult.user);
  if (!isWhitelisted) {
    const forbiddenError = new Error(
      `Acceso restringido: El usuario SAP '${sapAuthResult.user}' no tiene permisos para acceder al Monitor SAP. Solicite su inclusión en la lista de acceso a los administradores DREDONDO o HPEREZ.`
    );
    forbiddenError.statusCode = 403;
    forbiddenError.sapCode = 'MONITOR_ACCESS_FORBIDDEN';
    throw forbiddenError;
  }

  const now = Date.now();
  const token = crypto.randomBytes(32).toString('hex');
  const session = {
    token,
    username: sapAuthResult.user,
    client: sapAuthResult.client,
    sysId: sapAuthResult.sysId || 'BOP',
    host: sapAuthResult.host || SAP_CONFIG.ashost || '10.0.0.100',
    authMode: sapAuthResult.mode || 'SAP_LIVE_RFC',
    loginAt: now,
    expiresAt: now + SESSION_TTL_MS,
    isAdmin: isWhitelistAdmin(sapAuthResult.user),
    canManageWhitelist: isWhitelistAdmin(sapAuthResult.user)
  };

  await saveSession(session);
  return session;
}

/**
 * Extrae el token de sesión desde el header Authorization (Bearer) o desde las cookies.
 */
function extractTokenFromReq(req) {
  const authHeader = req.headers?.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const t = authHeader.slice(7).trim();
    if (t && t !== 'null' && t !== 'undefined') return t;
  }

  const cookieHeader = req.headers?.cookie || '';
  if (cookieHeader) {
    const parts = cookieHeader.split(';');
    for (const part of parts) {
      const [k, v] = part.trim().split('=');
      if (k === 'sap_session' && v) {
        return decodeURIComponent(v);
      }
    }
  }

  return null;
}

/**
 * Middleware Express para proteger los endpoints del Dashboard exigiendo sesión SAP activa
 * y validando que el usuario siga existiendo en la Whitelist.
 */
async function requireSapAuth(req, res, next) {
  try {
    const token = extractTokenFromReq(req);
    const session = await getSessionByToken(token);
    if (!session) {
      return res.status(401).json({
        authenticated: false,
        error: 'Sesión SAP requerida. Por favor inicie sesión con sus credenciales de SAP.'
      });
    }

    const isWhitelisted = await isUserWhitelisted(session.username);
    if (!isWhitelisted) {
      return res.status(403).json({
        authenticated: false,
        error: `Acceso revocado: El usuario SAP '${session.username}' ya no se encuentra en la lista de acceso al Monitor SAP.`,
        sapCode: 'MONITOR_ACCESS_REVOKED'
      });
    }

    req.sapSession = {
      ...session,
      isAdmin: isWhitelistAdmin(session.username),
      canManageWhitelist: isWhitelistAdmin(session.username)
    };
    next();
  } catch (err) {
    return res.status(401).json({
      authenticated: false,
      error: 'Error verificando sesión SAP.'
    });
  }
}

function getSapTargetMetadata() {
  return {
    ashost: SAP_CONFIG.ashost || '10.0.0.100',
    sysnr: SAP_CONFIG.sysnr || '00',
    client: SAP_CONFIG.client || '300',
    environment: process.env.ENVIRONMENT_NAME || 'PRODUCTIVO',
    sapLive: process.env.SAP_LIVE === 'true'
  };
}

module.exports = {
  loginWithSap,
  getSessionByToken,
  deleteSession,
  extractTokenFromReq,
  requireSapAuth,
  getSapTargetMetadata,
  WHITELIST_ADMINS,
  INITIAL_WHITELIST,
  isWhitelistAdmin,
  isUserWhitelisted,
  getWhitelist,
  addToWhitelist,
  removeFromWhitelist
};
