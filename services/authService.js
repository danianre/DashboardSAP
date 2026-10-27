const crypto = require('crypto');
const { SAP_CONFIG, verifySapCredentials } = require('../config/sap');
const { db } = require('./snapshotService');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas de vigencia de sesión
const sessionsCache = new Map();

// Inicializar tabla de sesiones en SQLite para persistir el login ante reinicios del servidor Node
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
});

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
    expiresAt: now + SESSION_TTL_MS
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
 * Middleware Express para proteger los endpoints del Dashboard exigiendo sesión SAP activa.
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
    req.sapSession = session;
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
  getSapTargetMetadata
};
