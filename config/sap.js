require('dotenv').config();

const https = require('https');

let rfcInitError = null;
let clientInstance = null;
let rfcQueue = Promise.resolve();

const SAP_CONFIG = {
  user: (process.env.SAP_USER || '').trim(),
  passwd: (process.env.SAP_PASSWORD || '').trim(),
  ashost: (process.env.SAP_ASHOST || '').trim(),
  sysnr: (process.env.SAP_SYSNR || '00').trim(),
  client: (process.env.SAP_CLIENT || '300').trim(),
  saprouter: process.env.SAP_ROUTER ? process.env.SAP_ROUTER.trim() : undefined,
  lang: 'ES'
};

async function getOrOpenClient() {
  if (rfcInitError) {
    throw new Error(`node-rfc no disponible: ${rfcInitError}`);
  }

  const { Client } = require('node-rfc');
  if (!clientInstance) {
    clientInstance = new Client(SAP_CONFIG);
  }

  if (!clientInstance.alive) {
    await clientInstance.open();
  }

  return clientInstance;
}

/**
 * Ejecuta una llamada RFC serializada de forma segura a través de una cola mutex,
 * eliminando por completo el error "device or resource busy" de node-rfc
 * cuando múltiples endpoints o timers del dashboard consultan a SAP simultáneamente.
 */
function executeRfc(functionName, parameters = {}) {
  const next = rfcQueue.then(async () => {
    const client = await getOrOpenClient();
    try {
      return await client.call(functionName, parameters);
    } catch (err) {
      if (client && !client.alive) {
        try { await client.close(); } catch (_) {}
        clientInstance = null;
      }
      throw err;
    }
  });

  rfcQueue = next.catch(() => {});
  return next;
}

// Wrapper retrocompatible para servicios existentes que consumen rfcClient
const rfcClient = {
  open: async () => {
    await getOrOpenClient();
    return true;
  },
  close: async () => {
    // Mantenemos la conexión viva para evitar el costo de re-autenticación TCP/RFC cada 5 segundos
    return true;
  },
  call: (funcName, params = {}) => executeRfc(funcName, params),
  get alive() {
    return clientInstance ? clientInstance.alive : false;
  }
};

try {
  const { Client } = require('node-rfc');
  console.log(`[OK] Conector node-rfc cargado. Apuntando a SAP ${SAP_CONFIG.ashost} (Mandante ${SAP_CONFIG.client})`);
} catch (err) {
  rfcInitError = err.message;
  console.error('[ALERTA SDK SAP] No se pudo cargar node-rfc o falta C:\\nwrfcsdk\\lib en el PATH:', err.message);
}

/**
 * Valida credenciales contra SAP NetWeaver ICM vía HTTPS (Puerto 44300 / SICF).
 * Permite validar usuarios corporativos directamente contra USR02 incluso en entornos
 * donde el SDK binario C++ de RFC (libsapnwrfc.so) no se encuentra instalado.
 */
function verifySapCredentialsHttp(username, password, client) {
  return new Promise((resolve, reject) => {
    const host = SAP_CONFIG.ashost || '10.0.0.100';
    const port = parseInt(process.env.SAP_HTTPS_PORT || '44300', 10);
    const sapClient = client || SAP_CONFIG.client || '300';

    const opt = {
      hostname: host,
      port: port,
      path: `/sap/bc/gui/sap/its/webgui?sap-client=${encodeURIComponent(sapClient)}`,
      method: 'GET',
      rejectUnauthorized: false,
      timeout: 6000,
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
        'User-Agent': 'SAP-Monitor-Gate/1.0'
      }
    };

    const req = https.request(opt, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        const cookies = res.headers['set-cookie'] || [];
        const sessionCookie = cookies.find(c => c.startsWith('SAP_SESSIONID'));
        if (sessionCookie) {
          const matchSys = sessionCookie.match(/SAP_SESSIONID_([A-Z0-9]+)_/i);
          const sysId = matchSys ? matchSys[1] : (process.env.SAP_SYSID || 'BOP');
          return resolve({
            authenticated: true,
            user: username.toUpperCase(),
            client: sapClient,
            sysId: sysId,
            host: host,
            partnerHost: host,
            kernelRel: '753',
            mode: 'SAP_LIVE_ICM_HTTPS'
          });
        }

        const err = new Error(`Usuario o contraseña de SAP incorrectos en el mandante ${sapClient}.`);
        err.key = 'RFC_LOGON_FAILURE';
        err.statusCode = 401;
        return reject(err);
      });
    });

    req.on('timeout', () => {
      req.destroy();
      const err = new Error(`Tiempo de espera agotado al conectar con SAP ICM (${host}:${port}).`);
      err.key = 'RFC_COMMUNICATION_FAILURE';
      reject(err);
    });

    req.on('error', (e) => {
      const err = new Error(`Error de conexión con SAP HTTPS (${host}:${port}): ${e.message}`);
      err.key = 'RFC_COMMUNICATION_FAILURE';
      reject(err);
    });

    req.end();
  });
}

/**
 * Valida las credenciales de un usuario directamente contra SAP NetWeaver.
 * Intenta primero la conexión RFC binaria nativa; si el SDK C++ no está instalado
 * o falla la librería de bajo nivel, valida directamente vía SAP ICM HTTPS (Puerto 44300).
 */
async function verifySapCredentials(username, password, client) {
  const cleanUser = String(username || '').trim();
  const cleanPass = String(password || '');
  const cleanClient = String(client || SAP_CONFIG.client || '300').trim();

  // 1. Si node-rfc está disponible y sin errores de inicialización, validar vía RFC binario
  if (!rfcInitError) {
    try {
      const { Client } = require('node-rfc');
      const loginConfig = {
        ...SAP_CONFIG,
        user: cleanUser,
        passwd: cleanPass,
        client: cleanClient,
        lang: 'ES'
      };

      const authClient = new Client(loginConfig);
      await authClient.open();
      const info = authClient.connectionInfo || {};
      try {
        await authClient.close();
      } catch (_) {}

      if (!SAP_CONFIG.user || SAP_CONFIG.user.toUpperCase() === cleanUser.toUpperCase()) {
        SAP_CONFIG.user = cleanUser;
        SAP_CONFIG.passwd = cleanPass;
        SAP_CONFIG.client = cleanClient;
      }

      return {
        authenticated: true,
        user: String(info.user || cleanUser).trim().toUpperCase(),
        client: String(info.client || cleanClient).trim(),
        sysId: String(info.sysId || 'BOP').trim(),
        host: String(info.host || SAP_CONFIG.ashost).trim(),
        partnerHost: String(info.partnerHost || SAP_CONFIG.ashost).trim(),
        kernelRel: String(info.kernelRel || '').trim(),
        mode: 'SAP_LIVE_RFC'
      };
    } catch (err) {
      const errKey = String(err?.key || err?.codeString || '').toUpperCase();
      const isSdkMissing =
        errKey === 'RFC_SDK_MISSING' ||
        String(err?.message || '').includes('libsapnwrfc') ||
        String(err?.message || '').includes('cannot open shared object file') ||
        String(err?.message || '').includes('not found');
      if (!isSdkMissing) {
        throw err;
      }
    }
  }

  // 2. Validación transparente contra SAP NetWeaver ICM HTTPS (Puerto 44300)
  return await verifySapCredentialsHttp(cleanUser, cleanPass, cleanClient);
}

module.exports = {
  SAP_CONFIG,
  rfcClient,
  executeRfc,
  verifySapCredentials,
  rfcInitError
};
