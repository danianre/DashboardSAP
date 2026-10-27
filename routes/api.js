const express = require('express');
const router = express.Router();
const {
  fetchSapDashboardData,
  manageUserLock,
  cancelWorkProcess,
  analyzeWorkProcesses
} = require('../services/sapService');
const {
  saveSnapshot,
  getSnapshotsLast8Hours
} = require('../services/snapshotService');
const {
  getRetiredBlockedUsersHistory
} = require('../services/hrJobService');
const {
  getPasswordResetsLog
} = require('../services/passwordResetService');
const {
  getSt02Metrics
} = require('../services/st02Service');
const {
  buildSt02Analysis
} = require('../services/st02Analysis');
const {
  loginWithSap,
  getSessionByToken,
  deleteSession,
  extractTokenFromReq,
  requireSapAuth,
  getSapTargetMetadata
} = require('../services/authService');

// ==========================================
// ENDPOINTS DE AUTENTICACIÓN SAP (LOGIN / LOGOUT / SESIÓN)
// ==========================================

router.get('/auth/me', async (req, res) => {
  try {
    const token = extractTokenFromReq(req);
    const session = await getSessionByToken(token);
    const sapTarget = getSapTargetMetadata();

    if (!session) {
      return res.status(401).json({
        authenticated: false,
        sapTarget
      });
    }

    res.json({
      authenticated: true,
      user: {
        username: session.username,
        client: session.client,
        sysId: session.sysId,
        host: session.host,
        authMode: session.authMode,
        loginAt: session.loginAt,
        expiresAt: session.expiresAt
      },
      sapTarget
    });
  } catch (error) {
    console.error('[ERROR ENDPOINT GET /api/auth/me]:', error);
    res.status(500).json({ authenticated: false, error: error.message });
  }
});

router.post('/auth/login', async (req, res) => {
  try {
    const { username, password, client } = req.body || {};
    const session = await loginWithSap(username, password, client);

    res.setHeader(
      'Set-Cookie',
      `sap_session=${encodeURIComponent(session.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${12 * 3600}`
    );

    res.json({
      success: true,
      authenticated: true,
      token: session.token,
      user: {
        username: session.username,
        client: session.client,
        sysId: session.sysId,
        host: session.host,
        authMode: session.authMode,
        loginAt: session.loginAt,
        expiresAt: session.expiresAt
      }
    });
  } catch (error) {
    console.warn('[SAP LOGIN RECHAZADO]:', error.message);
    const status = error.statusCode || 401;
    res.status(status).json({
      success: false,
      authenticated: false,
      error: error.message || 'No fue posible autenticar con SAP.',
      sapCode: error.sapCode || 'AUTH_FAILED'
    });
  }
});

router.post('/auth/logout', async (req, res) => {
  try {
    const token = extractTokenFromReq(req);
    await deleteSession(token);
    res.setHeader('Set-Cookie', 'sap_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    res.json({ success: true, authenticated: false });
  } catch (error) {
    console.error('[ERROR ENDPOINT POST /api/auth/logout]:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Proteger todos los endpoints de monitoreo y operación con sesión SAP válida
router.use(requireSapAuth);

// Endpoint principal del Dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const sapData = await fetchSapDashboardData();
    const resetMetrics = await getPasswordResetsLog();
    const st02Raw = await getSt02Metrics(false);
    const st02Analysis = await buildSt02Analysis(st02Raw, sapData.work_processes);
    const st02Metrics = { ...st02Raw, analysis: st02Analysis };

    const resetsToday = resetMetrics.resets_today ?? (sapData.resets_today || 0);
    const resetsMonth = resetMetrics.resets_month ?? (sapData.resets_month || resetMetrics.total_count || 4);
    const currentMonthNum = resetMetrics.current_month || (new Date().getMonth() + 1);

    // Calcular ocupación actual de procesos DIA, BTC y sesiones concurrentes
    let diaBusy = 0;
    let diaTotal = 0;
    let btcBusy = 0;
    let btcTotal = 0;
    if (Array.isArray(sapData.work_processes)) {
      sapData.work_processes.forEach(wp => {
        const status = (wp.wp_status || '').toLowerCase().trim();
        const isActive = (status === 'espera' || status === 'waiting')
          ? Boolean(wp.wp_bname && wp.wp_bname !== '-' && wp.wp_bname.trim() !== '')
          : true;

        if (wp.wp_typ === 'DIA') {
          diaTotal++;
          if (isActive) diaBusy++;
        } else if (wp.wp_typ === 'BTC') {
          btcTotal++;
          if (isActive) btcBusy++;
        }
      });
    }

    const diaBusyPct = diaTotal > 0 ? parseFloat(((diaBusy / diaTotal) * 100).toFixed(1)) : 0;
    const btcBusyPct = btcTotal > 0 ? parseFloat(((btcBusy / btcTotal) * 100).toFixed(1)) : 0;
    const activeSessions = Array.isArray(sapData.user_sessions) ? sapData.user_sessions.length : (sapData.active_users || 0);

    // Guardar o actualizar instantánea en el bloque actual de 5 segundos
    await saveSnapshot({
      active_sessions: activeSessions,
      dia_busy_pct: diaBusyPct,
      btc_busy_pct: btcBusyPct,
      sm12_locks: (sapData.sm12_locks || []).length,
      ws_errors: sapData.ws_errors_count || 0
    });

    // Obtener historial de 8 horas en intervalos de 15 segundos (~1.920 puntos continuos)
    const history = await getSnapshotsLast8Hours({
      active_sessions: activeSessions,
      dia_busy_pct: diaBusyPct,
      btc_busy_pct: btcBusyPct
    });

    res.json({
      ...sapData,
      current_metrics: {
        dia_busy: diaBusy,
        dia_total: diaTotal,
        dia_busy_pct: diaBusyPct,
        btc_busy: btcBusy,
        btc_total: btcTotal,
        btc_busy_pct: btcBusyPct,
        active_sessions: activeSessions
      },
      history,
      self_service_metrics: {
        rfc_name: 'Z_USER_RESET_PASSWORD',
        table: 'ZPW_RESET_LOG',
        total_resets: resetsMonth,
        resets_today: resetsToday,
        resets_month: resetsMonth,
        current_month: currentMonthNum,
        current_month_name: resetMetrics.current_month_name || 'Octubre',
        estimated_hours_saved: resetMetrics.estimated_hours_saved || parseFloat(((resetsMonth * 15) / 60).toFixed(1)) || 2.8,
        available_months: resetMetrics.available_months || []
      },
      st02_metrics: st02Metrics
    });
  } catch (error) {
    console.error('[ERROR ENDPOINT /api/dashboard]:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint de Acciones Rápidas (Bloqueo / Desbloqueo de Usuarios)
router.post('/action/user-lock', async (req, res) => {
  const { bname, action, lastDate } = req.body;
  try {
    const result = await manageUserLock(bname, action, lastDate);
    res.json(result);
  } catch (err) {
    console.error(`[ERROR GENERAL ACTION USER]`, err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Endpoint para Cancelar Work Processes (SM50)
router.post('/action/cancel-wp', async (req, res) => {
  const { wp_no } = req.body;
  try {
    const result = await cancelWorkProcess(wp_no);
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (err) {
    console.error(`[ERROR CANCELANDO WP ${wp_no}]`, err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Endpoint de Diagnóstico y Análisis Operativo de Procesos (SM50 / SM66)
router.get('/processes/analyze', async (req, res) => {
  try {
    const sapData = await fetchSapDashboardData();
    const diagnosis = analyzeWorkProcesses(sapData.work_processes, sapData.user_sessions);
    res.json(diagnosis);
  } catch (error) {
    console.error('[ERROR ENDPOINT GET /api/processes/analyze]:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/processes/analyze', async (req, res) => {
  try {
    let { work_processes, user_sessions } = req.body || {};
    if (!Array.isArray(work_processes)) {
      const sapData = await fetchSapDashboardData();
      work_processes = sapData.work_processes;
      user_sessions = sapData.user_sessions;
    }
    const diagnosis = analyzeWorkProcesses(work_processes, user_sessions);
    res.json(diagnosis);
  } catch (error) {
    console.error('[ERROR ENDPOINT POST /api/processes/analyze]:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint de Auditoría de Usuarios Bloqueados por Retiro de Personal (Job ZHR_BLOQUEO_RETIROS_DIARIO)
router.get('/hr-job/retired-users', async (req, res) => {
  try {
    const sapData = await fetchSapDashboardData();
    const history = await getRetiredBlockedUsersHistory();
    const { month, only_blocked } = req.query;

    let filteredUsers = history.users || [];
    if (only_blocked === 'true' || only_blocked === '1') {
      filteredUsers = filteredUsers.filter(u => u.has_sap_user);
    }
    if (month && month !== 'all') {
      filteredUsers = filteredUsers.filter(u => u.lock_date && u.lock_date.startsWith(month));
    }

    res.json({
      job_info: sapData.hr_job || {
        jobname: 'ZHR_BLOQUEO_RETIROS_DIARIO',
        status: 'F',
        strtdate: history.query_date.replace(/-/g, ''),
        strttime: '190009',
        enddate: history.query_date.replace(/-/g, ''),
        endtime: '190010'
      },
      ...history,
      filtered_count: filteredUsers.length,
      users: (month || only_blocked) ? filteredUsers : history.users
    });
  } catch (error) {
    console.error('[ERROR ENDPOINT GET /api/hr-job/retired-users]:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint de Logs de Autogestión de Claves (Tabla SAP ZPW_RESET_LOG)
router.get('/password-resets', async (req, res) => {
  try {
    const { month, user, refresh } = req.query;
    const forceRefresh = refresh === 'true' || refresh === '1';
    const data = await getPasswordResetsLog(forceRefresh, { month, user });
    res.json(data);
  } catch (error) {
    console.error('[ERROR ENDPOINT GET /api/password-resets]:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint de Monitor de Buffers y Memoria SAP (Transacción ST02 - Tune Summary)
router.get('/st02', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const data = await getSt02Metrics(forceRefresh);
    const analysis = await buildSt02Analysis(data);
    res.json({ ...data, analysis });
  } catch (error) {
    console.error('[ERROR ENDPOINT GET /api/st02]:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint de Monitor de Base de Datos SAP (DBACOCKPIT / ST04 / ST03N)
const { getDbacockpitMetrics } = require('../services/dbacockpitService');
router.get('/dbacockpit', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const data = await getDbacockpitMetrics(forceRefresh);
    res.json(data);
  } catch (error) {
    console.error('[ERROR ENDPOINT GET /api/dbacockpit]:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
