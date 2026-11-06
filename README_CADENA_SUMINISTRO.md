# Dashboard de Inteligencia y Optimización de la Cadena de Suministro — SAP Analytics Cloud (SAC)

Documentación técnica, funcional y matemática del módulo **Cadena de Suministro y Logística SAC** (`/cadena-suministro-sap`), integrado en tiempo real con **SAP ECC 6.0 (NetWeaver 750 — Mandante 300 Productivo)**.

---

## 1. Propósito y Alcance Ejecutivo

El módulo de **Inteligencia y Optimización de la Cadena de Suministro** proporciona una visión operativa, analítica y predictiva de extremo a extremo sobre los procesos de:

1. **Abastecimiento y Gestión de Proveedores:** Evaluación multicriterio con pesos configurables (8 dimensiones), ranking dinámico y recomendador por Costo Total de Adquisición (**TCO**).
2. **Control y Optimización Científica de Inventarios:** Estado por material, centro y almacén (libre utilización, reservado, calidad, bloqueado y tránsito), matriz combinada **ABC / XYZ (9 cuadrantes)**, cálculo de **Stock de Seguridad ($SS$)**, **Punto de Pedido ($ROP$)**, **Cantidad Económica de Pedido ($EOQ$)** y redistribución horizontal entre centros antes de comprar.
3. **Transporte, Tiempos Logísticos y Costos:** Desglose de tiempos de abastecimiento (*Inbound*) y expedición (*Outbound*), atribución de causas de retraso y análisis de costos por corredor, tonelada y kilómetro.
4. **Recomendador Inteligente de Rutas y Transportistas:** Optimizador multicriterio configurable que diferencia la tarifa nominal más baja de la opción con mejor desempeño integral.
5. **Análisis Predictivo (SAC Smart Predict):** Pronóstico a 6 meses con bandas de confianza al 95%, radar probabilístico de riesgo de desabastecimiento (*Stockout Risk*) y validación estadística (`MAE`, `RMSE`, `WAPE`).
6. **Simulación de Escenarios Operativos (What-If) y Plan de Acción:** 5 escenarios estratégicos y 10 palancas interactivas que cuantifican el impacto en capital de trabajo, OPEX logístico, OTIF y tiempos de entrega.

---

## 2. Arquitectura y Fuentes de Datos en SAP ECC 6.0

> **Nota de Diseño Ejecutivo:** En la interfaz principal de usuario (`/cadena-suministro-sap`) se emplea exclusivamente terminología ejecutiva de negocio en español, ocultando los códigos técnicos de tablas SAP para facilitar la lectura gerencial. La trazabilidad técnica completa se documenta a continuación:

| Dominio Logístico | Fuentes en SAP ECC 6.0 | Entidades y Campos Utilizados |
| :--- | :--- | :--- |
| **Centros y Compras** | `T001W`, `T024E` | Centros logísticos (`WERKS`, `NAME1`), Organizaciones de compras (`EKORG`, `EKOTX`). |
| **Abastecimiento** | `EBAN`, `EKKO`, `EKPO`, `EKET`, `EKBE`, `LFA1` | Solicitudes de pedido (`BADAT`, `FRGDT`), Órdenes de compra (`EBELN`, `AEDAT`, `LIFNR`), Entregas previstas (`EINDT`, `MENGE`), Recepciones reales (`BUDAT`, `BWART 101/102/122`). |
| **Inventarios y MRP** | `MARD`, `MARC`, `MBEW`, `MAKT` | Libre utilización (`LABST`), Control calidad (`INSME`), Bloqueado (`SPEME`), En traslado/tránsito (`UMLME`, `TRAME`), Stock seguridad (`EISBE`), Punto de pedido (`MINBE`), Stock máximo (`MABST`), Valoración (`SALK3`). |
| **Transporte y Rutas** | `LIKP`, `LIPS`, `VTTK`, `TVRO`, `TVROT` | Entregas de salida (`VBELN`, `WADAT`, `WADAT_IST`, `BTGEW`, `NTGEW`), Documentos de transporte (`TKNUM`, `TDLNR`), Maestro de rutas y distancias reales en KM (`ROUTE`, `BEZEI`, `DISTZ`). |
| **Costos de Fletes** | `FAGLFLEXT` | Cuentas contables de fletes, transporte terrestre/portuario y almacenamiento en moneda funcional (`COP`). |

### Alcance de Módulos Complementarios
- **SAP EWM / WM:** El control de existencias se realiza a nivel de Centro (`WERKS`) y Almacén (`LGORT`).
- **SAP TM (`VFKK`):** Los costos de transporte se integran desde la contabilidad analítica de fletes y el tarifario operativo por ruta/tonelada/kilómetro.
- **SAP IBP:** Las capacidades de pronóstico estadístico, cálculo de $SS$, $ROP$, $EOQ$ y simulación de escenarios se ejecutan directamente en el motor matemático de [`services/supplyChainAnalyticsService.js`](services/supplyChainAnalyticsService.js).

---

## 3. Estructura de las 7 Páginas del Dashboard

1. **Página 1 — Resumen Ejecutivo y Alertas:** 12 KPIs principales, 6 indicadores complementarios, evolución histórica de 12 meses y sistema de alertas inteligentes (Crítico, Advertencia, Normal).
2. **Página 2 — Proveedores y Abastecimiento (TCO):** Scorecard multicriterio con 8 pesos configurables, ranking ordenable y comparador multiproveedor por material basado en Costo Total de Adquisición (TCO).
3. **Página 3 — Control y Optimización de Inventarios:** Matriz interactiva **ABC / XYZ (9 cuadrantes)**, diagnóstico de inventarios problemáticos, cálculo científico de $SS$, $ROP$, $EOQ$ y recomendador de traslados entre centros.
4. **Página 4 — Transporte, Tiempos y Costos:** Desglose de etapas del ciclo de abastecimiento, atribución de causas de retraso y costos unitarios por corredor (`COP/Ton`, `COP/KM`, `% Ocupación`).
5. **Página 5 — Recomendador de Rutas y Flota:** Optimizador multicriterio de rutas y transportistas con 6 pesos configurables.
6. **Página 6 — Análisis Predictivo (Smart Predict):** Pronóstico de demanda e inventario a 6 meses, radar probabilístico de riesgo de quiebre y métricas `MAE`, `RMSE` y `WAPE`.
7. **Página 7 — Simulador de Escenarios y Acciones:** 5 escenarios preconfigurados, 10 palancas interactivas en vivo y plan priorizado de recomendaciones operativas.

---

## 4. Fórmulas Matemáticas Implementadas

- **Stock de Seguridad Científico ($SS$):**
  $$SS = Z \times \sqrt{\overline{L} \cdot \sigma_D^2 + \overline{D}^2 \cdot \sigma_L^2}$$
- **Punto de Pedido ($ROP$):**
  $$ROP = (\overline{D} \times \overline{L}) + SS$$
- **Cantidad Económica de Pedido ($EOQ$ — Fórmula de Wilson):**
  $$EOQ = \sqrt{\frac{2 \cdot D_{\text{anual}} \cdot S_{\text{pedido}}}{H_{\text{mantenimiento}}}}$$
- **Costo Total de Adquisición Unitario ($TCO$):**
  $$TCO = P_{\text{nominal}} + C_{\text{flete}} + C_{\text{no calidad}} + C_{\text{financiamiento SS}}$$

---

## 5. Endpoints de la API

- `GET /api/cadena-suministro/overview` — Obtiene el estado completo de las 7 páginas y catálogos (soporta `?refresh=true`).
- `POST /api/cadena-suministro/overview` — Recalcula indicadores aplicando filtros globales, pesos de proveedores, pesos de rutas y palancas de simulación.
- `POST /api/cadena-suministro/simulate` — Ejecuta en tiempo real el motor de simulación *What-If* de la cadena de suministro.
