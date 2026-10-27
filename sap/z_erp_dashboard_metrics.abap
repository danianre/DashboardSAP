FUNCTION z_erp_dashboard_metrics.
*"----------------------------------------------------------------------
*"*"Interfase local
*"  EXPORTING
*"     VALUE(EV_JSON_RESPONSE) TYPE  STRING
*"----------------------------------------------------------------------

  DATA: lv_date_30d      TYPE sy-datum,
        lv_active_users  TYPE i,
        lv_locked_admin  TYPE i,
        lv_locked_failed TYPE i,
        lv_expired_users TYPE i,
        lv_dumps_today   TYPE i,
        lv_ws_errors     TYPE i,
        lv_resets_today TYPE i,
        lv_resets_month TYPE i,
        lv_first_day    TYPE sy-datum.

  " --- Detección de Entorno (Calidad vs Productivo) ---
  DATA: lv_cccategory TYPE t000-cccategory,
        lv_env_name   TYPE string.

  SELECT SINGLE cccategory FROM t000 INTO lv_cccategory
    WHERE mandt = sy-mandt.

  CASE lv_cccategory.
    WHEN 'P'.
      lv_env_name = 'PRODUCTIVO'.
    WHEN 'T'.
      lv_env_name = 'CALIDAD (TEST)'.
    WHEN 'D' OR 'W'.
      lv_env_name = 'DESARROLLO'.
    WHEN OTHERS.
      lv_env_name = 'OTRO / SANDBOX'.
  ENDCASE.
  " -----------------------------------------------------------

  " Fecha límite para inactividad BASC V6 (30 días atrás)
  lv_date_30d = sy-datum - 30.

  " KPIs del Parque de Usuarios (Idéntico a RSUSR200 -> Usuarios válidos hoy)
  SELECT COUNT(*) FROM usr02 INTO lv_active_users
    WHERE ( ustyp = 'A' OR ustyp = 'C' )
      AND ( gltgv = '00000000' OR gltgv <= sy-datum )
      AND ( gltgb = '00000000' OR gltgb >= sy-datum ).

  " Bloqueados por Administrador (dentro de los usuarios válidos hoy)
  SELECT COUNT(*) FROM usr02 INTO lv_locked_admin
    WHERE ( ustyp = 'A' OR ustyp = 'C' )
      AND ( gltgv = '00000000' OR gltgv <= sy-datum )
      AND ( gltgb = '00000000' OR gltgb >= sy-datum )
      AND ( uflag = 32 OR uflag = 64 ).

  " Bloqueados por intentos fallidos (dentro de los usuarios válidos hoy)
  SELECT COUNT(*) FROM usr02 INTO lv_locked_failed
    WHERE ( ustyp = 'A' OR ustyp = 'C' )
      AND ( gltgv = '00000000' OR gltgv <= sy-datum )
      AND ( gltgb = '00000000' OR gltgb >= sy-datum )
      AND uflag >= 128.

  " Usuarios no válidos hoy (Vencidos de fecha)
  SELECT COUNT(*) FROM usr02 INTO lv_expired_users
    WHERE ( ustyp = 'A' OR ustyp = 'C' )
      AND gltgb <> '00000000'
      AND gltgb < sy-datum.

  " Lista de Usuarios Activos sin conexión en los últimos 30 días (BASC V6)
  TYPES: BEGIN OF ty_inactive_user,
           bname TYPE usr02-bname,
           class TYPE usr02-class,
           trdat TYPE usr02-trdat,
           erdat TYPE usr02-erdat,
         END OF ty_inactive_user.
  DATA: lt_inactive TYPE STANDARD TABLE OF ty_inactive_user.

  SELECT bname class trdat erdat FROM usr02
    INTO TABLE lt_inactive UP TO 100 ROWS
    WHERE ( ustyp = 'A' OR ustyp = 'C' )
      AND uflag = 0
      AND ( gltgb = '00000000' OR gltgb >= sy-datum )
      AND ( ( trdat <> '00000000' AND trdat < lv_date_30d )
         OR ( trdat = '00000000'  AND erdat < lv_date_30d ) ).

  " Verificar Job Crítico: ZHR_BLOQUEO_RETIROS_DIARIO (TBTCO)
  TYPES: BEGIN OF ty_job,
           jobname   TYPE tbtco-jobname,
           status    TYPE tbtco-status,
           strtdate  TYPE tbtco-strtdate,
           strttime  TYPE tbtco-strttime,
           enddate   TYPE tbtco-enddate,
           endtime   TYPE tbtco-endtime,
         END OF ty_job.
  DATA: ls_hr_job TYPE ty_job.

  SELECT SINGLE jobname status strtdate strttime enddate endtime
    FROM tbtco INTO ls_hr_job
    WHERE jobname = 'ZHR_BLOQUEO_RETIROS_DIARIO'
      AND strtdate = sy-datum.
  IF sy-subrc <> 0.
    " Si no ha corrido hoy, traer la última ejecución registrada
    SELECT jobname status strtdate strttime enddate endtime
      FROM tbtco INTO ls_hr_job UP TO 1 ROWS
      WHERE jobname = 'ZHR_BLOQUEO_RETIROS_DIARIO'
      ORDER BY strtdate DESCENDING strttime DESCENDING.
    ENDSELECT.
  ENDIF.

  " Work Processes Activos (SM50)
  DATA: lt_wpinfo TYPE STANDARD TABLE OF wpinfo.
  CALL FUNCTION 'TH_WPINFO'
    TABLES
      wplist = lt_wpinfo
    EXCEPTIONS
      OTHERS = 1.

  " Sesiones de Usuarios Conectados (AL08 / SM04)
  DATA: lt_uinfo TYPE STANDARD TABLE OF uinfo.
  CALL FUNCTION 'TH_USER_LIST'
    TABLES
      list   = lt_uinfo
    EXCEPTIONS
      OTHERS = 1.

  " Bloqueos Activos (SM12)
  DATA: lt_enq TYPE STANDARD TABLE OF seqg3.
  CALL FUNCTION 'ENQUEUE_READ'
    EXPORTING
      gclient = sy-mandt
      guname  = '*'
    TABLES
      enq     = lt_enq
    EXCEPTIONS
      OTHERS  = 1.

  " Short Dumps del día (ST22 - Tabla SNAP)
  SELECT COUNT(*) FROM snap INTO lv_dumps_today
    WHERE datum = sy-datum AND seqno = '000'.

  " Errores de Web Services / CPI del día (SRT_UTIL_ERRLOG)
  TYPES: BEGIN OF ty_ws_err,
           err_type   TYPE string,
           uname      TYPE srt_util_errlog-sapuser,
           timestamp  TYPE srt_util_errlog-timestamp,
           error_text TYPE srt_util_errlog-error_context,
           if_name    TYPE string,
         END OF ty_ws_err.
  DATA: lt_ws_errors TYPE STANDARD TABLE OF ty_ws_err.

  " FIX: Estructura temporal para consultar directamente los nombres reales en la BD
  TYPES: BEGIN OF ty_db_err,
           sapuser       TYPE srt_util_errlog-sapuser,
           timestamp     TYPE srt_util_errlog-timestamp,
           error_context TYPE srt_util_errlog-error_context,
         END OF ty_db_err.
  DATA: lt_db_err TYPE STANDARD TABLE OF ty_db_err.

  DATA: lv_ts_start  TYPE timestamp.
  CONVERT DATE sy-datum TIME '000000' INTO TIME STAMP lv_ts_start TIME ZONE sy-zonlo.

  " SELECT seguro consultando solo campos que existen físicamente
  SELECT sapuser timestamp error_context
    FROM srt_util_errlog
    INTO TABLE lt_db_err UP TO 50 ROWS
    WHERE timestamp >= lv_ts_start
    ORDER BY timestamp DESCENDING.

    " Reseteos de hoy
  SELECT COUNT(*) FROM zpw_reset_log INTO lv_resets_today
    WHERE datum = sy-datum.

  " Reseteos del mes en curso
  lv_first_day = sy-datum.
  lv_first_day+6(2) = '01'. " Construye el primer día del mes

  SELECT COUNT(*) FROM zpw_reset_log INTO lv_resets_month
    WHERE datum >= lv_first_day AND datum <= sy-datum.


  " Mapeo de la estructura de base de datos a la estructura JSON que espera tu app web
  LOOP AT lt_db_err INTO DATA(ls_db).
    APPEND INITIAL LINE TO lt_ws_errors ASSIGNING FIELD-SYMBOL(<fs_ws>).
    <fs_ws>-err_type   = 'WS_ERROR'.
    <fs_ws>-uname      = ls_db-sapuser.
    <fs_ws>-timestamp  = ls_db-timestamp.
    <fs_ws>-error_text = ls_db-error_context.
    <fs_ws>-if_name    = 'N/A'.
  ENDLOOP.

  lv_ws_errors = lines( lt_ws_errors ).

  " Empaquetar estructura completa y serializar a JSON
   TYPES: BEGIN OF ty_payload,
            environment     TYPE string,
            sysid           TYPE sy-sysid,
            client          TYPE sy-mandt,
            license_limit   TYPE i,               " <-- NUEVO CAMPO
            active_users    TYPE i,
            locked_admin    TYPE i,
            locked_failed   TYPE i,
            expired_users   TYPE i,
            dumps_today     TYPE i,
            ws_errors_count TYPE i,
            resets_today    TYPE i,
            resets_month    TYPE i,
            hr_job          TYPE ty_job,
            inactive_30d    LIKE lt_inactive,
            work_processes  LIKE lt_wpinfo,
            user_sessions   LIKE lt_uinfo,
            sm12_locks      LIKE lt_enq,
            ws_cpi_errors   LIKE lt_ws_errors,
          END OF ty_payload.

  DATA: ls_payload TYPE ty_payload.
  ls_payload-license_limit   = 334.               " <-- TU LÍMITE CONFIGURADO AQUÍ
  ls_payload-environment     = lv_env_name.
  ls_payload-sysid           = sy-sysid.
  ls_payload-client          = sy-mandt.
  ls_payload-active_users    = lv_active_users.
  ls_payload-locked_admin    = lv_locked_admin.
  ls_payload-locked_failed   = lv_locked_failed.
  ls_payload-expired_users   = lv_expired_users.
  ls_payload-dumps_today     = lv_dumps_today.
  ls_payload-ws_errors_count = lv_ws_errors.
  ls_payload-resets_today    = lv_resets_today.
  ls_payload-resets_month    = lv_resets_month.
  ls_payload-hr_job          = ls_hr_job.
  ls_payload-inactive_30d    = lt_inactive.
  ls_payload-work_processes  = lt_wpinfo.
  ls_payload-user_sessions   = lt_uinfo.
  ls_payload-sm12_locks      = lt_enq.
  ls_payload-ws_cpi_errors   = lt_ws_errors.

  ev_json_response = /ui2/cl_json=>serialize(
    data        = ls_payload
    pretty_name = /ui2/cl_json=>pretty_mode-low_case
  ).

ENDFUNCTION.