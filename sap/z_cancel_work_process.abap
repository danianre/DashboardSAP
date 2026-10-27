FUNCTION z_cancel_work_process.
*"----------------------------------------------------------------------
*"*"Interfase local
*"  IMPORTING
*"     VALUE(IV_WP_NO) TYPE  I
*"  EXPORTING
*"     VALUE(EV_SUCCESS) TYPE  FLAG
*"     VALUE(EV_MESSAGE) TYPE  STRING
*"----------------------------------------------------------------------

  " Include estándar del Taskhandler de SAP (contiene OPCODE_WP_STOP)
  INCLUDE tskhincl.

  DATA: lv_wp_no    TYPE wpinfo-wp_no,
        lv_wp_index TYPE wpinfo-wp_index.

  " Convertimos el número de proceso a ambos formatos de la estructura WPINFO
  lv_wp_no    = iv_wp_no.
  SHIFT lv_wp_no LEFT DELETING LEADING space.
  lv_wp_index = iv_wp_no.

  " Llamada directa al Kernel C de SAP (Idéntico a SM50 -> Proceso -> Cancelar sin core)
  CALL 'ThWpInfo' ID 'OPCODE'   FIELD opcode_wp_stop
                  ID 'WP'       FIELD lv_wp_no
                  ID 'WP_INDEX' FIELD lv_wp_index.

  IF sy-subrc = 0.
    ev_success = 'X'.
    ev_message = |Transacción en el Work Process { iv_wp_no } cancelada correctamente.|.
  ELSE.
    ev_success = '-'.
    ev_message = |No se pudo cancelar el WP { iv_wp_no } (Código Kernel SY-SUBRC: { sy-subrc }).|.
  ENDIF.

ENDFUNCTION.