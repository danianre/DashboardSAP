# Consola Integral de Monitoreo y Rendimiento SAP ERP
### Conectividad en Tiempo Real con SAP NetWeaver & Base de Datos Oracle

---

## 1. Resumen Ejecutivo del Proyecto

La **Consola Integral de Monitoreo y Rendimiento SAP ERP** es una plataforma web desarrollada para unificar, simplificar y automatizar la supervisión técnica, operativa y de licenciamiento del sistema SAP ERP corporativo.

### El Reto Operativo Tradicional
En una operación estándar de SAP, el equipo de TI, Basis y soporte se ve obligado a ingresar manualmente a múltiples transacciones técnicas dispersas en SAP GUI (`SM50`, `SM66`, `ST02`, `ST03N`, `ST04`, `DBACOCKPIT`, `SM12`, `ST22`, `AL08`, `SU01`, `SRT_UTIL`, `SM37`) para entender el estado de salud del sistema, evaluar bloqueos o diagnosticar lentitudes. Este proceso consume tiempo valioso, requiere conocimientos técnicos avanzados y dificulta la detección temprana de anomalías antes de que afecten a los usuarios finales.

### La Solución Desarrollada
Este proyecto conecta una aplicación web ágil y moderna directamente con el servidor de aplicaciones SAP (NetWeaver / ABAP) y el motor de base de datos Oracle, logrando:

1. **Visibilidad Ejecutiva y Técnica en Tiempo Real**: Refresco automático cada 5 segundos de procesos activos, memoria, buffers, bloqueos e interfaces; con series temporales de rendimiento muestreadas a 15 segundos y una ventana enfocada de 2 horas navegable sobre un historial completo de 8 horas.
2. **Diagnóstico Inteligente en 1 Clic**: Detección automática de procesos que superan tiempos límite (`TIME_OUT`), lecturas secuenciales masivas sobre tablas maestras (`BSEG`, `MSEG`), esperas por bloqueo (`ENQUEUE`) y saturación de hilos `DIA`/`BTC`.
3. **Monitoreo Especializado de Buffers (ST02) y Base de Datos (DBACOCKPIT)**: Identificación exacta de qué usuarios, programas o consultas SQL consumen más CPU, lecturas lógicas/físicas o generan demoras en la base de datos con diseño minimalista y explicaciones en español.
4. **Control de Licencias, Auditoría BASC / HCM y Reporte de Ahorro CADI**: Seguimiento continuo del tope de licencias de diálogo (334 usuarios máximos permitidos), detección de cuentas inactivas por más de 30 días, verificación del job nocturno de retiro de colaboradores desvinculados y cuantificación ejecutiva del retorno de inversión (ROI) con cálculo de horas hombre ahorradas por la autogestión de contraseñas.
5. **Impacto Cero en Producción**: Diseñado bajo un principio estricto de solo lectura (*read-only*), cachés inteligentes en memoria y serialización de llamadas, garantizando que el monitoreo no añada sobrecarga al sistema productivo.
6. **Arquitectura Unificada Multi-Vista (`https://apps-sap.daabon.com.co` / `10.0.0.146:3000`)**: Coexistencia transparente en un mismo servidor Node.js/Express (puerto `3000`, carpeta `/home/plant/apps-sap`) de tres aplicaciones empresariales bajo el portal corporativo `/`:
   * **Monitor SAP (`/monitor-sap`)**: Consola técnica Basis/TI en tiempo real.
   * **Notificaciones SAP (`/notificaciones-sap`)**: Notificación de órdenes de fabricación, tiempos y `COGI` con SSO Microsoft.
   * **Optimizador de Inventarios IA (`/inventarios-sap`)**: Analítica inteligente de excesos de inventario (`ZFMM_STOCK_BY_WERKS`) y proyección estacional de demanda (`ZFMM_HISTORICO_CONSUMO` / `MVER`) impulsada por IA.

---

## 2. Arquitectura de Conectividad con SAP Productivo

La conexión entre la aplicación web y el entorno productivo de SAP no utiliza scraping ni emuladores de interfaz gráfica; combina el **protocolo oficial binario RFC (Remote Function Call)** de SAP SE (para el Monitor ERP en `/monitor`) y servicios HTTP REST sobre **SAP Cloud Integration (CPI)** (para Notificaciones de Producción en `/`).

### 2.1. Enrutamiento y Aislamiento de Aplicaciones en `10.0.0.146:3000` (`apps-sap.daabon.com.co`)

| Característica | Selector Principal (`/`) | Aplicación 1: Monitor SAP (`/monitor-sap`) | Aplicación 2: Notificaciones SAP (`/notificaciones-sap`) | Aplicación 3: Optimizador de Inventarios IA (`/inventarios-sap`) |
| :--- | :--- | :--- | :--- | :--- |
| **URL de Acceso** | `https://apps-sap.daabon.com.co/` | `https://apps-sap.daabon.com.co/monitor-sap` | `https://apps-sap.daabon.com.co/notificaciones-sap` | `https://apps-sap.daabon.com.co/inventarios-sap` |
| **Archivo Frontend** | `public/index.html` | `public/monitor.html` | `public/notificaciones.html` | `public/inventarios.html` |
| **Rol / Propósito** | Portal corporativo «Plataforma de Aplicaciones SAP» con 3 tarjetas de módulos | Dashboard técnico Basis/TI en tiempo real | Registro y contabilización de órdenes de producción en planta | Auditoría de excesos de stock (`EXCESO_INV`) y proyección estacional (`PROYECCION_INV`) con IA |
| **Autenticación** | Acceso directo al hub corporativo | SAP Logon Gate directo vía RFC (`USR02`) con Control de Lista Blanca (`sap_monitor_whitelist`) | Microsoft Entra ID / Azure AD SSO (`MSAL.js`) | Conexión directa a SAP RFC (`node-rfc`) + Motor Analítico IA |
| **Integración SAP** | Healthcheck (`/api/health`) | SAP NetWeaver RFC SDK (`node-rfc` binario C++) | SAP CPI (`axios` Basic Auth vía variables `.env`) | RFCs `ZFMM_STOCK_BY_WERKS` y `ZFMM_HISTORICO_CONSUMO` (`MVER`) + SAP CPI / Gemini IA |
| **Base de Datos Local**| N/A | `monitor_sap.sqlite` (`system_snapshots`, `password_resets_log`, `sap_auth_sessions`, `sap_monitor_whitelist`) | `database.sqlite` (Tabla `logs` de órdenes notificadas) | Procesamiento en memoria con minificación matricial de tokens |
| **Rutas API** | `GET /api/health` | `POST /api/auth/*`, `GET /api/dashboard`, `GET /api/st02`, `GET /api/dbacockpit`, `GET/POST/DELETE /api/whitelist` | `POST /api/orden`, `POST /api/notificacion`, `GET /api/logs` | `POST /api/inventarios/stock`, `POST /api/inventarios/consumo`, `POST /api/inventarios/ai-analyze` |

### Diagrama de Arquitectura de la Solución

```mermaid
flowchart TD
    subgraph Cliente["Navegador Web (Usuario / TI)"]
        UI["Dashboard Web Interactivo\n(HTML5 + Tailwind CSS + Chart.js)"]
    end

    subgraph Middleware["Servidor de Aplicación (Node.js)"]
        API["Servicio REST Express 5\n(routes/api.js)"]
        Mutex["Cola Mutex Serializada\n(config/sap.js - rfcQueue)"]
        Cache["Caché Inteligente en Memoria\n(TTLs de 5s, 20s y 30s)"]
        SQLite["Base de Datos Local SQLite\n(monitor_sap.sqlite - Histórico 8h)"]
        NodeRFC["node-rfc v3.3.1\n(Addon Nativo C++ N-API)"]
    end

    subgraph OS["Capa de Sistema Operativo"]
        SDK["SAP NetWeaver RFC SDK 7.50\n(C:\\nwrfcsdk\\lib - DLLs Binarias C/C++)"]
    end

    subgraph Red["Infraestructura de Comunicaciones"]
        Router["SAP Router Corporativo\n(/H/sap.daabon.com.co)"]
    end

    subgraph SAP["SAP ERP Productivo (NetWeaver / ABAP)"]
        Dispatcher["SAP Dispatcher & Gateway\n(Puerto 3300 / Instancia 00)"]
        ZCustom["Módulos RFC a Medida:\n- Z_ERP_DASHBOARD_METRICS\n- Z_CANCEL_WORK_PROCESS"]
        StandardRFC["Módulos RFC Estándar SAP:\n- SAPTUNE_GET_SUMMARY_STATISTIC (ST02)\n- SWNC_COLLECTOR_GET_AGGREGATES (ST03N)\n- STUO_GET_ORA_SYS_TABLE (V$SQLAREA)\n- MONITOR_SM_ORASESSION (Sesiones BD)\n- RFC_READ_TABLE (ZHR_LOG, ZPW_RESET)\n- BAPI_USER_LOCK / UNLOCK / CHANGE"]
        Oracle["Motor de Base de Datos Oracle\n(SAPSR3 - Tablas de Negocio y V$ Views)"]
    end

    UI <-->|HTTP / JSON cada 5s| API
    API --> Cache
    API --> SQLite
    API --> Mutex
    Mutex --> NodeRFC
    NodeRFC --> SDK
    SDK -->|Protocolo Binario RFC (TCP)| Router
    Router --> Dispatcher
    Dispatcher --> ZCustom
    Dispatcher --> StandardRFC
    ZCustom --> Oracle
    StandardRFC --> Oracle
```

---

## 3. ¿Cómo Funciona la Conexión? (Explicación Paso a Paso)

Para que un sistema externo hable con SAP de forma segura y homologada por SAP SE, deben cumplirse tres pilares:

### 3.1. ¿Qué es un RFC (Remote Function Call)?
Un **RFC** es el estándar de comunicación cliente-servidor nativo de SAP. Permite que programas externos invoquen módulos de funciones creados dentro de SAP como si fueran procedimientos locales. 
* Los datos viajan codificados en un formato binario optimizado propio de SAP.
* Cada llamada es autenticada con usuario, contraseña, mandante e idioma.
* Las llamadas se ejecutan dentro del contexto de seguridad y autorizaciones del Application Server.

### 3.2. Herramientas Instaladas para Conectar con SAP

Para materializar esta conexión en un entorno Node.js se instalaron e integraron dos herramientas fundamentales:

1. **SAP NetWeaver RFC SDK 7.50 (Librería Binaria Oficial C/C++)**:
   * Es el kit de desarrollo oficial compilado por SAP en C/C++.
   * Contiene los controladores binarios de bajo nivel que implementan el protocolo de red hacia el Dispatcher de SAP:
     * **En Windows**: `C:\nwrfcsdk\lib` (`libsapnwrfc.dll`, `libsapucum.dll`, `icudt50.dll`, etc.).
     * **En Servidor Linux (`10.0.0.146`)**: `/home/plant/nwrfcsdk/lib` (`libsapnwrfc.so`, `libsapucum.so`, `libicuuc57.so`, `libicui18n57.so`, `libicudata57.so`), extraídos directamente del kernel SAP NetWeaver 754 Linux x86_64 (`bonprd`).
   * **Variables de Entorno y Auto-Resolución ELF (`config/sap.js`)**:
     * `SAPNWRFC_HOME`: Apunta a `C:\nwrfcsdk` (Windows) o `/home/plant/nwrfcsdk` (Linux).
     * `LD_LIBRARY_PATH` / `PATH`: Incluye `/home/plant/nwrfcsdk/lib` (Linux) o `C:\nwrfcsdk\lib` (Windows). Además, `config/sap.js` incluye `ensureLinuxRfcSdkPaths()`, que sincroniza automáticamente el `DT_RPATH` ELF de `node.napi.node`, `libsapnwrfc.so` y `libsapucum.so` hacia `/home/plant/nwrfcsdk/lib` antes de cargar `node-rfc`, garantizando que el enlazador dinámico (`ld.so`) encuentre las librerías incluso tras reinicios de PM2 o reinstalaciones de `npm`.

2. **`node-rfc` (Paquete npm nativo / Wrapper para Node.js)**:
   * Es el conector oficial de código abierto respaldado por la comunidad SAP que enlaza el entorno JavaScript de Node.js con la librería C++ del SAP NW RFC SDK mediante N-API.
   * Permite instanciar un cliente RFC (`new Client(SAP_CONFIG)`), abrir conexiones TCP autenticadas y consumir funciones ABAP con sintaxis asíncrona moderna (`await client.call('NOMBRE_FUNCION', parametros)`).

### 3.3. Parámetros de Conexión Configurados (`.env`)
La conexión se parametriza mediante variables de entorno seguras:

| Parámetro | Variable `.env` | Ejemplo de Valor | Descripción |
| :--- | :--- | :--- | :--- |
| **Modo En Vivo** | `SAP_LIVE` | `true` | Determina si conecta en vivo a SAP o usa modo de respaldo simulado. |
| **Servidor Host** | `SAP_ASHOST` | `10.0.0.100` | Dirección IP o hostname del Application Server de SAP. |
| **Instancia** | `SAP_SYSNR` | `00` | Número de sistema/instancia de SAP (define el puerto TCP `3300`). |
| **Mandante** | `SAP_CLIENT` | `300` | Entorno de datos de negocio de SAP (Mandante productivo). |
| **SAP Router** | `SAP_ROUTER` | `/H/sap.daabon.com.co` | Cadena de salto seguro a través del firewall perimetral corporativo. |
| **Usuario de Conexión**| `SAP_USER` | `[USUARIO_SERVICIO]` | Cuenta de diálogo o de comunicación RFC en SAP. |
| **Clave** | `SAP_PASSWORD` | `[PASSWORD_SEGURO]` | Contraseña de autenticación en SAP. |
| **Idioma** | `lang` | `ES` | Idioma de las sesiones y mensajes de error devueltos. |

### 3.4. Mecanismo de Seguridad y Mutex (Manejo de Concurrencia)
Uno de los retos técnicos más importantes resueltos en el proyecto es la **gestión de la concurrencia**:
* **Problema**: El conector `node-rfc` opera sobre un socket RFC abierto. Si dos peticiones simultáneas del navegador (o dos temporizadores automáticos de refresco) intentan enviar llamadas RFC al mismo tiempo por la misma conexión, el conector genera la excepción crítica `device or resource busy` o bloquea el socket.
* **Solución Implementada (`config/sap.js`)**: Se diseñó una **cola mutex serializada mediante promesas (`rfcQueue`)**:
  ```javascript
  function executeRfc(functionName, parameters = {}) {
    const next = rfcQueue.then(async () => {
      const client = await getOrOpenClient();
      return await client.call(functionName, parameters);
    });
    rfcQueue = next.catch(() => {});
    return next;
  }
  ```
* **Ventajas**:
  1. Todas las consultas hacia SAP se organizan en fila india a nivel de milisegundos sin colisionar.
  2. Se mantiene la conexión abierta (*Keep-Alive*), evitando el costo computacional de realizar un nuevo *handshake* TCP y autenticación en cada consulta.
  3. Si la conexión se interrumpe temporalmente, el cliente detecta la caída y se reconecta de manera transparente.

### 3.5. Inicio de Sesión con Credenciales de SAP (`SAP Logon Gate`)
El acceso al Dashboard está protegido por autenticación directa contra SAP NetWeaver (`services/authService.js`):
* **Validación en Vivo (`verifySapCredentials`)**: Al ingresar el **Mandante** (`300`), **Usuario SAP** y **Contraseña**, el backend abre un handshake RFC dedicado con `node-rfc` (`authClient.open()`) contra el servidor SAP.
* **Control de Estado de Cuenta SAP (`USR02`)**: SAP verifica automáticamente si la clave es correcta, si el usuario está bloqueado en `SU01`, si superó el límite de intentos fallidos o si su vigencia expiró, devolviendo diagnósticos claros en español.
* **Experiencia de Acceso Segura y Minimalista**: La interfaz de inicio de sesión abstrae y oculta los detalles de infraestructura técnica que el usuario no necesita ver (como host del servidor, número de instancia y protocolo de transporte) y presenta un campo de usuario limpio con un indicador discreto (`*`), garantizando una experiencia ágil idéntica al ingreso al ERP.
* **Gestión de Sesión**: Una vez autenticado, el servidor emite un token criptográfico de 256 bits (`Bearer Token` y cookie `HttpOnly` `sap_session`) persistido en SQLite (`sap_auth_sessions`), protegiendo todos los endpoints `/api/*` mediante el middleware `requireSapAuth`.

---

## 4. Módulos y RFCs: Código a Medida vs. Funciones Estándar

El proyecto combina dos tipos de módulos de función en SAP: módulos propios desarrollados específicamente para este dashboard y módulos estándar del Kernel de SAP.

### 4.1. Módulos RFC a Medida (Desarrollo Propio en ABAP)

#### A. `Z_ERP_DASHBOARD_METRICS` (Consolidador Maestro de Telemetría)
* **Objetivo**: Proveer en un solo viaje de red (*single round-trip*) toda la información vital del sistema para alimentar el dashboard en menos de 300 ms.
* **Tablas y Vistas que consulta internamente**:
  * `T000`: Detecta automáticamente si el mandante actual es Productivo (`P`), Calidad (`T`) o Desarrollo (`D`).
  * `USR02`: Calcula en tiempo real las licencias activas (idéntico a la transacción estándar `RSUSR200`), usuarios bloqueados por intentos fallidos (`uflag >= 128`), bloqueados por administrador (`uflag = 32 o 64`), usuarios vencidos de fecha (`gltgb < sy-datum`) e inactivos por más de 30 días (estándar BASC V6).
  * `TBTCO`: Verifica el estatus y tiempos de ejecución del job crítico de nómina `ZHR_BLOQUEO_RETIROS_DIARIO`.
  * `TH_WPINFO` (Kernel SAP): Obtiene los Work Processes activos (`SM50`).
  * `TH_USER_LIST` (Kernel SAP): Obtiene las sesiones de usuarios concurrentes (`AL08`).
  * `ENQUEUE_READ`: Lee la tabla de bloqueos en memoria de SAP (`SM12`).
  * `SNAP`: Cuenta los Short Dumps generados en el día (`ST22`).
  * `SRT_UTIL_ERRLOG`: Extrae los errores de Web Services SOAP/REST y conectores de integración SAP Cloud Integration (CPI).
  * `ZPW_RESET_LOG`: Lee las operaciones de autogestión de contraseñas de la plataforma CADI.
* **Optimización de Salida**: Serializa los datos internamente con la clase nativa de ultra-alta velocidad `/ui2/cl_json=>serialize`, retornando una cadena JSON limpia y directa hacia Node.js.

#### B. `Z_CANCEL_WORK_PROCESS` (Mitigación Segura de Procesos)
* **Objetivo**: Permitir a los ingenieros Basis cancelar un proceso colgado o infinito desde el dashboard web sin tener que entrar a la `SM50` y sin riesgo de tirar la instancia.
* **Mecanismo Técnico**: Invoca de manera controlada la rutina estándar del Taskhandler de SAP (`opcode_wp_stop` mediante `CALL 'ThWpInfo'`).
* **Seguridad**: Cancela la transacción del hilo *sin generar un volcado de memoria (core dump)*, liberando el proceso de diálogo para que atienda a otros usuarios.

---

### 4.2. Módulos RFC Estándar Reutilizados de SAP

Para evitar reinventar la rueda y garantizar precisión absoluta con las transacciones oficiales de SAP GUI, se consumen los siguientes módulos estándar:

| Módulo RFC Estándar | Transacción Equivalente | Función en el Dashboard |
| :--- | :--- | :--- |
| **`SAPTUNE_GET_SUMMARY_STATISTIC`** | **ST02** (Tune Summary) | Extrae la estadística completa de todos los buffers de SAP (Nametab, PXA, Tables Buffer, CUA, Screen, Export/Import) y áreas de memoria (Extended Memory, Heap Memory, Paging, Contextos PRIV). |
| **`SWNC_COLLECTOR_GET_AGGREGATES`** | **ST03N** (Workload Monitor) | Obtiene los acumulados de carga de trabajo de Hoy y Ayer: usuarios con mayor tiempo de base de datos y CPU, transacciones más ejecutadas y distribución horaria. |
| **`STUO_GET_ORA_SYS_TABLE`** | **DBACOCKPIT / ST04** | Lee de manera segura y parametrizada la vista dinámica de Oracle `V$SQLAREA` para identificar las sentencias SQL más costosas en disco, memoria y tiempo. |
| **`MONITOR_SM_ORASESSION`** | **DBACOCKPIT -> Sessions** | Monitorea en vivo las sesiones activas en la base de datos Oracle, correlacionando el proceso del sistema operativo (`SPID`) con el usuario y reporte de SAP. |
| **`DB_ORA_GET_RELEASE`** | **DBACOCKPIT** | Identifica la versión y nivel de parches del motor Oracle de la base de datos. |
| **`DB_ORA_INSTANCE_INFO`** | **DBACOCKPIT** | Extrae la fecha y hora de inicio de la base de datos y su estado operativo. |
| **`RFC_READ_TABLE`** | **SE16N / SE11** | Lee de manera segura registros tabulares de auditoría para `ZHR_LOG_BLOQUEO` (retiros de personal) y `ZPW_RESET_LOG` (autogestión de claves). |
| **`BAPI_USER_LOCK` / `UNLOCK`** | **SU01** | Aplica o retira el bloqueo administrativo sobre cuentas de usuario en SAP. |
| **`BAPI_USER_CHANGE`** | **SU01** | Modifica la fecha de fin de validez (`GLTGB`) en los datos de logon para vencer cuentas preventivamente. |

---

## 5. Módulos Funcionales del Dashboard

La aplicación web está organizada en seis módulos especializados:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 1. CINTA DE KPIs SUPERIOR (Licencias 334 | Inactivos +30d | Bloqueados | CADI | SM12/ST22 | WS CPI)   │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 2. GRÁFICA DE RENDIMIENTO DEL SISTEMA (Historial 8 Horas: Ocupación DIA % y BTC %)     │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 3. MONITOR DE WORK PROCESSES EN VIVO (SM50) + DIAGNÓSTICO BASIS AUTOMÁTICO EN 1 CLIC    │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 4. PANEL EJECUTIVO Y TÉCNICO ST02 (Memoria Extendida, Heap, Hit Ratios, Swaps Buffers)  │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 5. MÓDULO DBACOCKPIT (Top Usuarios, Top Programas, Top Sentencias SQL V$SQLAREA, BD)  │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 6. VENTANAS MODALES INTERACTIVAS DE AUDITORÍA Y DETALLE (SM12, ST22, SRT_UTIL, ZHR, CADI)│
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 5.1. Cinta de KPIs Ejecutivos (Cabecera)
* **Licencias de Diálogo en Uso**: Compara en tiempo real los usuarios válidos conectados frente al límite máximo contractual (334 usuarios). Alerta en amarillo al superar el 95% y en rojo al llegar al tope.
* **Inactivos +30 Días (Norma BASC V6)**: Detecta colaboradores que tienen más de un mes sin ingresar al sistema para aplicar bloqueo preventivo.
* **Bloqueados y Vencidos**: Separa usuarios con clave bloqueada por intentos erróneos (`uflag >= 128`), bloqueos administrativos y cuentas expiradas.
* **Autogestión de Claves CADI**: Monitorea cuántos usuarios han desbloqueado o cambiado su clave sin llamar a la mesa de ayuda, estimando horas de soporte técnico ahorradas en el mes. La tarjeta incluye accesos directos tanto al **Historial de Logs** como al **Reporte de Ahorro**.
* **Bloqueos SM12 y Dumps ST22**: Tarjeta interactiva clicable que abre la ventana modal con la auditoría en tiempo real de objetos retenidos en `SM12` y los volcados de memoria `ST22` del día, manteniendo la vista principal despejada y libre de sobrecarga.
* **Errores Web Services / CPI (SRT_UTIL)**: Tarjeta interactiva clicable que abre el detalle de fallos en interfaces de facturación electrónica y recaudos del día.

### 5.2. Gráfica de Rendimiento DIA / BTC (Historial 8 Horas con Ventana de 2h a 15s)
* **Muestreo Continuo cada 15 Segundos**: Registra muestras continuas cada 15 segundos en una base de datos local SQLite (`monitor_sap.sqlite`), logrando una animación y actualización fluida en tiempo real.
* **Ventana Visible de 2 Horas**: La gráfica proyecta en pantalla un bloque enfocado de **2 horas continuas** (480 puntos cronológicos a 15s) para mantener una línea nítida, precisa y libre de sobrecarga visual.
* **Historial General Navegable de 8 Horas**: La base de datos y la memoria del navegador retienen la jornada completa de **8 horas** (~1.920 puntos continuos).
* **Barra Deslizante y Controles Temporales**:
  * *Slider continuo*: Permite desplazar la ventana de 2 horas hacia atrás o adelante a través de toda la jornada de 8 horas para auditar momentos de alta demanda o caídas.
  * *Botones de salto rápido*: `-1h`, `-15m`, `+15m` y `+1h` para explorar momentos específicos con un solo clic.
  * *Modo En Vivo (`🔴 Últimas 2h`)*: Bloquea automáticamente la gráfica al extremo más reciente del tiempo real con avance automático cada 15 segundos.

### 5.3. Monitor de Work Processes en Vivo (SM50 / SM66)
* Muestra la tabla de hilos del Application Server (Número de proceso, tipo `DIA`/`BTC`/`UPD`/`SPO`, estado, usuario, programa ABAP en ejecución, acción de base de datos, tiempo transcurrido y tabla intervenida).
* **Diseño Compacto con Tamaño Fijo (8 Filas)**: La tabla de procesos activos se encuentra confinada a un tamaño fijo de **8 filas** con barra de desplazamiento vertical integrada (`overflow-y-auto`) a la derecha, garantizando que una ráfaga de procesos no desplace ni deforme la estructura del dashboard.
* **Botón "Diagnosticar Procesos en 1 Clic"**: Abre un auditor inteligente que evalúa:
  * Semáforo de salud del Dispatcher.
  * Procesos en riesgo de `TIME_OUT` (> 300 segundos en Diálogo).
  * Lecturas secuenciales pesadas en tablas críticas (`BSEG`, `BKPF`, `MSEG`, `ACDOCA`).
  * Contención por bloqueos encolados (`SM12`).
  * Concentración anómala de hilos por un mismo usuario.
  * Plan de acción y mitigación operativa recomendada para Basis.
* **Acción de Cancelación**: Permite cancelar procesos descontrolados con confirmación de seguridad.

### 5.4. Panel Ejecutivo y Técnico ST02 — Memoria y Buffers SAP
Diseñado con una estética minimalista para responder rápidamente dos preguntas críticas: *¿Falta memoria?* y *¿Están los buffers intercambiando con el disco?*
* **KPIs de Calidad Global**: Hit Ratio global de acceso a base de datos, Hit Ratio del Cursor Cache de SQL y total de Swaps acumulados.
* **Monitoreo de Áreas de Memoria**:
  * *Memoria Extendida (Extended Memory)*: Monitorea el espacio de memoria compartida principal de las sesiones de usuario.
  * *Memoria Heap (Heap Memory / PRIV)*: Detecta si algún hilo entró en modo privado exclusivo (`PRIV Mode`), lo cual indica agotamiento de la memoria extendida y riesgo de cuello de botella en el Dispatcher.
  * *Paging Area*: Monitorea el archivo de intercambio temporal.
* **Matriz de Buffers Críticos**:
  * Evalúa los 12 buffers de SAP: Nametab (`TTAB`, `FTAB`, `SNTAB`, `IRBD`), Programa ABAP (`PXA`), CUA, Pantallas (`PRES`), Calendario (`CALE`), OTR, Tablas (`TABL`), Export/Import (`EIBUF`) y Shared Memory (`ESM`).
  * Calcula porcentaje de espacio libre, objetos libres en directorio, swaps y fallos de buffer.
  * Emite alertas técnicas con el nombre exacto del parámetro SAP (`rz10` / `rz11`) a ajustar.

### 5.5. Módulo DBACOCKPIT — Consumo y Rendimiento de Base de Datos
Complementa el monitoreo de SAP con la perspectiva profunda del motor Oracle:
* **Panel A. Usuarios con Mayor Consumo**: Ranking por tiempo total de base de datos, tiempo de CPU, cantidad de ejecuciones y lecturas lógicas/físicas. Distingue claramente entre cuentas técnicas de integración (`QLIK`, `CONEXION`, `SAPSYS`) y usuarios finales de negocio.
* **Panel B. Programas y Transacciones**: Identifica los programas ABAP causantes del mayor impacto en la base de datos (por ejemplo, extractores de BI, jobs de facturación electrónica o listados contables).
* **Panel C. Top Sentencias SQL (V$SQLAREA)**: Catálogo de las consultas SQL más costosas de la memoria caché compartida de Oracle, exponiendo:
  * `SQL_ID` y texto sanitizado de la consulta SQL.
  * Tiempo acumulado y tiempo promedio por ejecución (en milisegundos).
  * Lecturas lógicas (Buffer Gets) y lecturas físicas de disco (Disk Reads).
  * Patrón de carga (Costo unitario elevado vs. frecuencia masiva de ejecución).
  * Explicación de impacto y tabla involucrada.
* **Panel D. Actividad Actual en Vivo**: Sesiones de Oracle abiertas en tiempo real correlacionadas con el Work Process de SAP y los eventos de espera (*wait events*).
* **Panel E. Evolución y Tendencias**: Comparativo de consumo y comportamiento de la base de datos entre Hoy y Ayer.

### 5.6. Ventanas Modales de Detalle (UI Minimalista)
Para no sobrecargar la pantalla principal, los detalles pesados se abren en ventanas modales optimizadas:
* **Modal de Bloqueos SM12 y Dumps ST22**: Tabla completa de bloqueos con buscador en tiempo real, selector de páginas (5, 10, 25, 50 filas) y cálculo de minutos retenidos; junto al listado detallado de volcados ST22 del día.
* **Modal de Interfaces Web Services y CPI (SRT_UTIL)**: Trazabilidad de caídas HTTP 502, errores de estructura XML y timeouts de endpoints de facturación y bancos.
* **Modal de Retiros de Personal (ZHR_LOG_BLOQUEO)**: Auditoría de empleados desvinculados procesados por el job nocturno, con filtro por mes y exportación a CSV.
* **Modal de Autogestión de Claves (ZPW_RESET_LOG)**:
  * *Filtro por Mes e Historial Multimes*: Selector desplegable para auditar meses específicos (ej. Octubre 2026) o el consolidado histórico acumulado.
  * *Buscador Dinámico de Usuario*: Filtro instantáneo por nombre de usuario SAP.
  * *Tarjetas Dinámicas de Resumen*: Recálculo en vivo de autogestiones del período, tiempo Basis ahorrado y usuarios únicos beneficiados.
  * *Exportación a CSV*: Descarga completa de registros con columna de ahorro estimado por evento (15 minutos).
* **Modal de Reporte Ejecutivo de Retorno de Inversión (ROI) y Tiempo Ahorrado**:
  * *Métricas Gerenciales de Impacto*: Horas de soporte Basis liberadas ($T = \frac{N \times 15\text{ min}}{60}$), tickets de mesa de ayuda evitados, inactividad de usuarios prevenida (SLA tradicional de 30-45 min vs. < 1 min en CADI) y disponibilidad 24/7 con 100% de éxito.
  * *Fundamentación Metodológica*: Comparativo transparente entre el flujo manual tradicional (atención, validación de identidad, transacción `SU01`, reseteo y notificación) y el autoservicio automatizado vía RFC.
  * *Histórico Mensual Comparativo y Top Usuarios*: Evolución mes a mes y ranking de los colaboradores con mayor frecuencia de uso.
  * *Distribución Horaria*: Gráfico de uso por franjas (mañana, tarde y noche/fines de semana), evidenciando la cobertura fuera de horario de soporte.
  * *Acciones Ejecutivas*: Botón **"Copiar Resumen para Jefatura"** (formato texto listo para enviar por Teams o correo) y botón **"Imprimir / Guardar como PDF"** con estilos `@media print` profesionales.

### 5.7. Módulo 3: Analítica Inteligente de Inventarios (`Optimizador de Inventarios IA`)
Disponible en `/inventarios-sap` (`public/inventarios.html` + `services/inventoryService.js`), integra la gestión de materiales SAP MM (`MARD`, `MARC`, `MVER`) con Inteligencia Artificial:
* **Modo A — Excesos de Inventario (`EXCESO_INV` · RFC `ZFMM_STOCK_BY_WERKS`)**:
  * Consulta en vivo las existencias por Centro (`WERKS`) y Rango de Material (`MATNR`), consolidando almacenes (`LGORT`) frente a los parámetros MRP de `MARC` (`MABST` Stock Máximo, `EISBE` Stock de Seguridad y `MINBE` Punto de Pedido).
  * Clasifica automáticamente cada material en: `Exceso de Stock`, `Posible Sobrestock (Sin Máx.)`, `Quiebre de Stock (0)`, `Bajo Stock Seguridad`, `En Punto de Pedido`, `Nivel Óptimo` o `Sin Parámetros MRP`.
* **Modo B — Proyección y Demanda Estacional (`PROYECCION_INV` · RFC `ZFMM_HISTORICO_CONSUMO` / `MVER`)**:
  * Incluye validación obligatoria de Centro (`WERKS`) y Rango de Material (`MATNR`) para proteger a SAP contra consultas masivas.
  * Consume `ZFMM_HISTORICO_CONSUMO` (y cuenta con fallback directo a `MVER` + `MAKT` + `MARA` bajo la estructura `ZST_IA_CONSUMO` si el módulo no tiene activo el flag *Remote-Enabled* en `SE37`).
  * Calcula media mensual, desviación estándar ($\sigma_d$), Coeficiente de Variación ($CV\%$), mes pico estacional, pronóstico ponderado del próximo trimestre y Stock de Seguridad sugerido al 95% de nivel de servicio ($Z = 1.65 \cdot \sigma_d$).
* **Minificación de Payload y Selección Dinámica de Modelo IA**:
  * `minifyInventoryPayload()`: Transforma los arreglos JSON verbosos en una matriz compacta delimitada por pipes (`|`) y pivota los 12 meses (`M01..M12`) por año, reduciendo el consumo de tokens entre un **65% y un 96%**.
  * `selectOptimalAiModel()`: Selecciona automáticamente entre **Gemini 2.5 Flash** (para auditorías tabulares rápidas de baja latencia y alta cuota RPM/TPM libre de errores `HTTP 429`) y **Gemini 2.5 Pro** (para descomposición matemática de series temporales extensas), soportando despacho hacia **SAP CPI iFlow** (`CPI_URL_INVENTARIOS_IA`), **Google Gemini API** (`GEMINI_API_KEY`) y el **Motor Analítico Cuantitativo Híbrido** local con disponibilidad garantizada 24/7.
  * Incluye visualizador modal en formato Markdown estructurado con botones para **Copiar Informe**, **Exportar a PDF** y **Exportar a Excel (CSV)**.

---

## 6. Stack Tecnológico y Paquetes Instalados

| Componente | Tecnología / Paquete | Versión | Rol en la Solución |
| :--- | :--- | :--- | :--- |
| **Backend Runtime** | **Node.js** | `>= 18.x / 20.x` | Motor de ejecución del servidor web y servicios de fondo. |
| **Framework HTTP** | **Express** | `^5.3.0` | Enrutamiento de APIs REST y servidor de contenido estático web. |
| **Conector SAP** | **`node-rfc`** | `^3.3.1` | Addon nativo C++ para enlazar Node.js con el SAP NetWeaver RFC SDK. |
| **SAP SDK Binario** | **SAP NW RFC SDK** | `7.50` | Bibliotecas C/C++ binarias oficiales de comunicación de SAP. |
| **Base de Datos Local** | **SQLite3 + `sqlite`** | `^6.0.1` / `^5.1.1`| Bases de datos embebidas independientes (`monitor_sap.sqlite` para telemetría de 8h a 15s y sesiones RFC; `database.sqlite` para auditoría de notificaciones de planta). |
| **Cliente HTTP CPI** | **`axios`** | `^1.20.0` | Consumo de endpoints REST de SAP Cloud Integration (CPI) para consulta y contabilización de órdenes de producción. |
| **Variables de Entorno**| **dotenv** | `^18.0.8` | Gestión segura de configuraciones y credenciales fuera del código fuente. |
| **CORS Middleware** | **cors** | `^2.8.6` | Seguridad de peticiones de origen cruzado para las rutas de la API. |
| **Frontend UI** | **HTML5 Semántico + Vanilla JS**| Estándar | Vistas desacopladas (`public/index.html` para Planta y `public/monitor.html` para Monitor SAP), sin compilación pesada. |
| **Autenticación SSO** | **MSAL Browser** | `2.35.0` | Inicio de sesión corporativo con Microsoft Azure AD en la vista de Notificaciones de Planta. |
| **Diseño y Estilos** | **Tailwind CSS** | CDN v3 | Framework utilitario moderno de diseño con modo claro (Planta) y modo oscuro corporativo (Monitor SAP). |
| **Visualización Gráfica**| **Chart.js** | v4 | Renderizado de gráficas temporales interactivas y responsivas. |
| **Iconografía** | **FontAwesome 6** | CDN Pro | Iconografía técnica para estados, advertencias y métricas. |

---

## 7. Guía de Instalación, Configuración y Puesta en Marcha

Sigue estos pasos para desplegar y ejecutar el proyecto desde cero en un servidor Windows o estación de trabajo:

### Paso 1: Instalar Requisitos Previos del Sistema
1. **Node.js**: Descargar e instalar Node.js LTS (versión 18 o 20) desde [nodejs.org](https://nodejs.org/).
2. **Herramientas de Compilación C++ (si se compila node-rfc localmente)**:
   ```powershell
   npm install --global --production windows-build-tools
   # o instalar Visual Studio Community con la carga de trabajo "Desktop development with C++"
   ```
3. **Instalar el SAP NetWeaver RFC SDK 7.50**:
   * Descargar el paquete `nwrfc750X_X-XXXXXXXX.SAR` desde el SAP Software Download Center (requiere usuario SAP S-User).
   * Descomprimir con la herramienta `SAPCAR` en la ruta:
     `C:\nwrfcsdk`
   * Verificar que existan las carpetas `include`, `lib` y `bin` dentro de `C:\nwrfcsdk`.

### Paso 2: Configurar las Variables de Entorno de Windows
1. Abrir **Propiedades del Sistema** -> **Variables de Entorno**.
2. En **Variables del Sistema**, agregar o verificar:
   * **Nombre**: `SAPNWRFC_HOME` | **Valor**: `C:\nwrfcsdk`
3. En la variable **`Path`** del sistema, agregar una nueva entrada:
   * `C:\nwrfcsdk\lib`
4. *Importante*: Cerrar y volver a abrir la terminal de PowerShell o CMD para que el sistema tome los cambios del `Path`.

### Paso 3: Clonar el Proyecto e Instalar Dependencias
Abrir la terminal en la carpeta raíz del proyecto (`DashboardSAP`):
```powershell
cd "c:\Users\dredondo\Downloads\Recursos de CPI\DashboardSAP"
npm install
```

### Paso 4: Configurar el Archivo de Entorno (`.env`)
Crear o verificar el archivo `.env` en la raíz del proyecto con la siguiente estructura:

```ini
# Activar conexión real con SAP (true = Conexión Real RFC / false = Simulación local)
SAP_LIVE=true

# Credenciales y Dirección del Servidor SAP
SAP_USER=tu_usuario_sap
SAP_PASSWORD=tu_contraseña_sap
SAP_ASHOST=10.0.0.100
SAP_SYSNR=00
SAP_CLIENT=300

# Enrutamiento de Red (SAP Router Corporativo)
SAP_ROUTER=/H/sap.daabon.com.co

# Nombre descriptivo del entorno
ENVIRONMENT_NAME=PRODUCTIVO
```

### Paso 5: Validar e Iniciar el Servidor Unificado
Ejecutar validación previa y arranque:
```powershell
npm run validate
node server.js
```

La consola confirmará el inicio exitoso de la plataforma y sus módulos:
```text
[OK] Conector node-rfc cargado. Apuntando a SAP 10.0.0.100 (Mandante 300)
========================================================
 🚀 Plataforma de Aplicaciones SAP activa en puerto 3000
 🏠 Selector Principal:   http://localhost:3000/
 📊 Monitor SAP ERP:      http://localhost:3000/monitor-sap
 🔔 Notificaciones SAP:   http://localhost:3000/notificaciones-sap
========================================================
✅ Base de datos SQLite (Notificaciones Planta: database.sqlite) lista.
```

### Paso 6: Abrir en el Navegador (Dominio Corporativo, Servidor `10.0.0.146` o Local)
* **Página Principal («Plataforma de Aplicaciones SAP»)**:
  👉 **`https://apps-sap.daabon.com.co/`** (o `http://10.0.0.146:3000/`)
* **Aplicación 1 — Monitor SAP (Basis / TI)**:
  👉 **`https://apps-sap.daabon.com.co/monitor-sap`** (o `http://10.0.0.146:3000/monitor-sap`)
* **Aplicación 2 — Notificaciones SAP (Planta / Microsoft SSO)**:
  👉 **`https://apps-sap.daabon.com.co/notificaciones-sap`** (o `http://10.0.0.146:3000/notificaciones-sap`)
* **Redirección de Retrocompatibilidad**:
  Cualquier usuario que ingrese a **`https://notificaciones-sap.daabon.com.co`** es redirigido automáticamente a **`https://notificaciones-sap.daabon.com.co/notificaciones-sap`**, preservando intacto el flujo histórico de planta.

### Paso 7: Flujo CI/CD, Despliegue Controlado y Reversión en Linux (`plant@10.0.0.146`)
1. **Validación y Publicación desde Antigravity**:
   * Para validar, publicar en GitHub (`main`) y desplegar inmediatamente al servidor Linux en un solo paso:
     ```bash
     npm run deploy
     ```
   * O siguiendo el flujo estándar Git (el sincronizador automático `scripts/auto-sync-github.sh` en el servidor detecta nuevos commits en `origin/main` cada minuto y ejecuta el despliegue controlado):
     ```bash
     npm run validate
     git add .
     git commit -m "feat: descripción del cambio"
     git push origin main
     ```
2. **Automatización GitHub Actions (`.github/workflows/deploy.yml`)**:
   * **Job 1 (`validate`)**: Verifica en Ubuntu que no existan archivos `.env` ni `.sqlite` rastreados, valida la sintaxis de todos los servicios JS (`node --check`), comprueba la integridad de las 3 vistas HTML y escanea que no existan secretos expuestos. Si falla, detiene el pipeline.
   * **Job 2 (`deploy`)**: Ejecuta `scripts/deploy-remote.sh` vía SSH cuando los secretos `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_PRIVATE_KEY` y `DEPLOY_PATH` están definidos.
3. **Dónde Consultar los Registros del Despliegue**:
   * **En vivo vía HTTP**: `GET https://apps-sap.daabon.com.co/api/health` o `http://10.0.0.146:3000/api/health` (muestra `commit`, `deployedAt` y `uptimeSeconds`).
   * **En GitHub**: Pestaña **Actions** de `https://github.com/danianre/DashboardSAP/actions`.
   * **En el Servidor Linux (`10.0.0.146`)**:
     * Directorio de despliegue: `/home/plant/apps-sap`
     * Bitácora histórica de despliegues: `/home/plant/apps-sap/deploy.log`
     * Metadatos de versión activa: `/home/plant/apps-sap/.deploy-meta.json`
     * Logs en tiempo real del proceso Node.js: `pm2 logs apps-sap`
4. **Respaldo, Trazabilidad y Procedimiento de Reversión (`scripts/rollback-remote.sh`)**:
   * Antes de aplicar cualquier actualización, `scripts/deploy-remote.sh` genera un respaldo en `/home/plant/apps-sap/backups/release_YYYYMMDD_HHMMSS.tar.gz` (además del respaldo inicial en `/home/plant/backups_app_notificaciones_sap/backup_pre_integracion_initial.tar.gz`).
   * Si `node scripts/validate-build.js` falla antes de recargar PM2, el script restaura inmediatamente el commit previo (`git reset --hard`) sin tocar el proceso activo.
   * Si alguna de las rutas (`/api/health`, `/`, `/monitor-sap`, `/notificaciones-sap`) falla después de recargar PM2, ejecuta automáticamente `scripts/rollback-remote.sh`.
   * Para ejecutar una reversión manual inmediata a la última versión funcional:
     ```bash
     ssh plant@10.0.0.146 "cd /home/plant/apps-sap && bash scripts/rollback-remote.sh"
     ```

---

## 8. Consideraciones de Seguridad y Buenas Prácticas

1. **Credenciales y Archivo `.env`**:
   * El archivo `.env` contiene credenciales sensibles y nunca debe incluirse en repositorios públicos de control de versiones (`.gitignore`).
   * Se recomienda crear un usuario de servicio en SAP exclusivo para esta herramienta (tipo `COMMUNICATION` o `SYSTEM`) en la transacción `SU01`.
2. **Permisos Mínimos Requeridos en SAP (Perfil de Autorizaciones)**:
   * Objeto de autorización `S_RFC`: Autorización para ejecutar los módulos de función `Z_ERP_DASHBOARD_METRICS`, `Z_CANCEL_WORK_PROCESS`, `SAPTUNE_GET_SUMMARY_STATISTIC`, `SWNC_COLLECTOR_GET_AGGREGATES`, `STUO_GET_ORA_SYS_TABLE`, `MONITOR_SM_ORASESSION`, `RFC_READ_TABLE`, `BAPI_USER_LOCK`, `BAPI_USER_UNLOCK`, `BAPI_USER_CHANGE`.
   * Objeto de autorización `S_TABU_DIS`: Autorización de lectura para los grupos de tablas correspondientes.
3. **Auditoría de Acciones**:
   * Las acciones que modifican el estado de un usuario (bloqueo preventivo o ajuste de vigencia) quedan registradas automáticamente en el log de modificaciones de documentos de usuario en SAP (`SU01` / `USH02` / `SM20`).
4. **Resiliencia ante Fallos de Red**:
   * Si el enlace de red con SAP o el SAP Router se interrumpe, la aplicación no colapsa: atrapa el error limpiamente, informa el estado en el banner superior y muestra datos de respaldo para no interrumpir la navegación. En cuanto el enlace vuelve, la reconexión es automática.
5. **Control de Acceso y Gestión de Lista Blanca (Whitelist) del Monitor SAP**:
   * El acceso a la consola de monitoreo técnico está estrictamente restringido a usuarios autorizados mediante la tabla `sap_monitor_whitelist` en `monitor_sap.sqlite`.
   * **Usuarios Autorizados por Defecto**: `DREDONDO`, `HPEREZ`, `JCUESTA`, `JANDRADE`, `SISTEMAS` y `CONEXION`.
   * **Administradores de la Whitelist**: Únicamente los usuarios `DREDONDO` y `HPEREZ` tienen permisos (`isAdmin: true`) para visualizar la lista y agregar o revocar usuarios autorizados desde el modal de administración en el header (`#btnWhitelistAdmin`) o vía los endpoints protegidos `/api/whitelist`.
   * Cualquier usuario autenticado en SAP que no figure en la lista blanca recibe un código `403 FORBIDDEN` con el mensaje explícito indicándole solicitar acceso a `DREDONDO` o `HPEREZ`.

---

## 9. Glosario Rápido para Analistas y Liderazgo

* **Basis**: Equipo de ingenieros responsables de la administración técnica, rendimiento, configuración y mantenimiento del sistema SAP y su infraestructura.
* **Work Process (WP)**: Hilos de ejecución del servidor SAP que atienden las solicitudes de los usuarios. Los más comunes son `DIA` (Diálogo / transacciones interactivas) y `BTC` (Batch / procesos en segundo plano).
* **Short Dump (ST22)**: Terminación anormal de un programa ABAP debido a un error no controlado en tiempo de ejecución (por ejemplo, desbordamiento de memoria o sintaxis inválida).
* **Enqueue (SM12)**: Mecanismo de bloqueo lógico de SAP que evita que dos usuarios modifiquen el mismo registro (por ejemplo, el mismo pedido o documento contable) simultáneamente.
* **Buffer (ST02)**: Área de memoria RAM ultra-rápida en el servidor de aplicaciones donde SAP precarga tablas, programas y pantallas para no tener que consultarlos en la base de datos en cada clic.
* **Swaps de Buffer**: Ocurre cuando un buffer se llena y SAP se ve obligado a expulsar un objeto a disco para cargar uno nuevo, degradando la velocidad del sistema.
* **Hit Ratio**: Porcentaje de éxito con el que una consulta encontró los datos directamente en memoria caché sin necesidad de ir a disco. Lo ideal es mantenerlo por encima del 98%.
* **CPI / Cloud Integration**: Plataforma en la nube de SAP para integrar procesos de negocio (por ejemplo, Facturación Electrónica DIAN y pasarelas bancarias) con el ERP local.
