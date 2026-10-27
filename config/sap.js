require('dotenv').config();

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
 * Valida las credenciales de un usuario directamente contra SAP NetWeaver vía RFC.
 * Abre una sesión dedicada de autenticación, obtiene metadatos del sistema y la cierra de inmediato.
 */
async function verifySapCredentials(username, password, client) {
  if (rfcInitError) {
    const err = new Error(`Conector SAP (node-rfc) no disponible: ${rfcInitError}`);
    err.key = 'RFC_SDK_MISSING';
    throw err;
  }

  const { Client } = require('node-rfc');
  const cleanUser = String(username || '').trim();
  const cleanPass = String(password || '');
  const cleanClient = String(client || SAP_CONFIG.client || '300').trim();

  const loginConfig = {
    ...SAP_CONFIG,
    user: cleanUser,
    passwd: cleanPass,
    client: cleanClient,
    lang: 'ES'
  };

  const authClient = new Client(loginConfig);
  try {
    await authClient.open();
    const info = authClient.connectionInfo || {};
    try {
      await authClient.close();
    } catch (_) {}

    // Si no había usuario configurado en .env o es el mismo usuario, actualizar credenciales activas en memoria
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
    try {
      if (authClient && authClient.alive) await authClient.close();
    } catch (_) {}
    throw err;
  }
}

module.exports = {
  SAP_CONFIG,
  rfcClient,
  executeRfc,
  verifySapCredentials,
  rfcInitError
};
