# Dashboard de Inteligencia y Análisis de Riesgos Financieros — SAP Analytics Cloud (SAC)
### Riesgo Crediticio de Clientes (ECL), Antigüedad de Cartera, Exposición Cambiaria, Sensibilidad Macroeconómica, Modelos Predictivos (Smart Predict) y Pruebas de Estrés

---

## 1. Propósito Ejecutivo y Alcance Funcional

El **Dashboard de Inteligencia y Análisis de Riesgos Financieros** (`/riesgos-financieros-sap`) es una solución de inteligencia financiera corporativa diseñada bajo los estándares de **SAP Analytics Cloud (SAC)** y conectada al entorno **SAP ECC 6.0 (Mandante 300 - Grupo Daabon)**.

Integra cuatro módulos estratégicos en una arquitectura de **7 páginas ejecutivas**:
1. **Módulo 1 — Evaluación del Riesgo Crediticio de Clientes:** Clasificación de riesgo (Bajo, Medio, Alto, Crítico), Score Crediticio (0–100), Antigüedad de Cartera (Aging en 5 tramos), DSO, utilización de cupos de crédito y cálculo de **Pérdida Crediticia Esperada ($ECL = PD \times LGD \times EAD$)**.
2. **Módulo 2 — Análisis del Impacto de Fluctuaciones Económicas:** Balance de **Exposición Cambiaria Neta** por divisa (`USD`, `EUR`, `COP`), sensibilidad de deuda a **Tasa Fija (36.6%) vs. Tasa Variable (63.4%)**, e impacto inflacionario (**Crecimiento Nominal vs. Real**, **Efecto Precio vs. Efecto Volumen** y **Pass-Through %**).
3. **Módulo 3 — Modelos Predictivos (SAC Smart Predict):**
   - **Escenario 1 (Clasificación):** Probabilidad de incumplimiento a 90 días (`AUC-ROC = 0.892`, `Precisión = 84.6%`, `Recall = 81.8%`, `KI = 0.784`, `KR = 0.861`, Matriz de Confusión *Out-of-Time*).
   - **Escenario 2 (Regresión):** Estimación de cartera vencida y exposición crediticia (`RMSE`, `MAE`, $R^2 = 0.884$).
   - **Escenario 3 (Series Temporales):** Pronóstico a 3, 6 y 12 meses de Cartera Vencida, DSO, Ingresos e Impacto Cambiario.
4. **Módulo 4 — Simulación de Escenarios y Pruebas de Estrés (*Stress Testing*):** 4 escenarios preconfigurados (*Optimista*, *Base Oficial*, *Adverso Moderado*, *Estrés Severo*) + Simulador interactivo con 8 variables macroeconómicas y crediticias en tiempo real.

---

## 2. Fuentes de Datos SAP ECC 6.0 y Gobierno de Datos

El servicio [`services/financialRiskService.js`](services/financialRiskService.js) extrae y consolida información real del entorno SAP ECC 6.0 mediante `RFC_READ_TABLE` serializado por `rfcQueue`, traduciendo todos los conceptos a lenguaje ejecutivo libre de códigos técnicos en la interfaz principal:

| Dominio Funcional | Entidad de Negocio (UI) | Tabla SAP ECC 6.0 | Campos Clave Utilizados |
| :--- | :--- | :--- | :--- |
| **Cuentas por Cobrar Abiertas** | Cartera por Cobrar Vigente y Vencida | `BSID` | `BUKRS`, `KUNNR`, `UMSKS`, `AUGDT`, `GJAHR`, `BELNR`, `BUDAT`, `BLDAT`, `WAERS`, `SHKZG`, `DMBTR`, `WRBTR`, `ZFBDT`, `ZBD1T`, `ZLSPR`, `MANSP` |
| **Historial de Pagos y Recaudos** | Comportamiento Histórico de Pago y DSO | `BSAD` | `BUKRS`, `KUNNR`, `AUGDT`, `BUDAT`, `WAERS`, `SHKZG`, `DMBTR`, `WRBTR`, `ZFBDT`, `ZBD1T` |
| **Gestión de Crédito Clásica** | Límites de Crédito, Exposición y Categoría | `KNKK` / `T014` | `KUNNR`, `KKBER`, `KLIMK`, `SKFOR`, `SAUFT`, `CTLPC`, `DTREV`, `NXTRV`, `WAERS` |
| **Condiciones Comerciales** | Plazos de Pago y Maestro de Clientes | `KNB1` / `KNA1` | `KUNNR`, `BUKRS`, `ZTERM`, `SPERR`, `NAME1`, `ORT01`, `LAND1` |
| **Pasivos Expuestos en Divisa** | Cuentas por Pagar y Obligaciones por Moneda | `BSIK` | `BUKRS`, `LIFNR`, `WAERS`, `SHKZG`, `DMBTR`, `WRBTR`, `ZFBDT`, `ZBD1T` |
| **Tipos de Cambio** | Tasa Representativa del Mercado (`USD`, `EUR`) | `TCURR` | `KURST`, `FCURR`, `TCURR`, `GDATU`, `UKURS` |

> **Nota de Arquitectura SAP:** En este entorno SAP ECC 6.0 se utiliza el módulo clásico **SAP FI-AR Credit Management (`KNKK` / `T014`)** en lugar de las tablas `UKMBP_CMS` de S/4HANA FSCM.
> **Regla de Gobierno (Secciones 3.7 y 12):** El dashboard es estrictamente analítico y consultivo; **nunca bloquea clientes/pedidos ni modifica límites de crédito automáticamente** en SAP. Toda acción sobre cupos o bloqueos requiere aprobación formal del Comité de Crédito.

---

## 3. Fórmulas Financieras y Reglas de Cálculo

1. **Exposición Crediticia Total (SAP Credit Management):**
   $$\text{Exposición Total} = \text{Cuentas por Cobrar Abiertas} + \text{Pedidos Abiertos No Facturados} + \text{Entregas No Facturadas} + \text{Partidas Especiales}$$
   *(Sin duplicar pedidos que ya se convirtieron en facturas abiertas).*
2. **Días de Cartera (DSO — Days Sales Outstanding):**
   $$\text{DSO} = \left(\frac{\text{Cuentas por Cobrar Totales}}{\text{Ventas a Crédito Anualizadas}}\right) \times 365$$
3. **Pérdida Crediticia Esperada (Expected Credit Loss — ECL):**
   $$\text{ECL} = PD \times LGD \times EAD$$
4. **Exposición Cambiaria Neta por Moneda:**
   $$\text{Exposición Cambiaria Neta} = \text{Activos Monetarios Expuestos (CxC + Caja)} - \text{Pasivos Monetarios Expuestos (CxP + Deuda)}$$

---

## 4. Endpoints REST del Módulo

| Método | Ruta | Descripción |
| :--- | :--- | :--- |
| `GET` | `/riesgos-financieros-sap` | Vista interactiva de 7 páginas en [`public/riesgos-financieros.html`](public/riesgos-financieros.html) |
| `GET / POST` | `/api/riesgos-financieros/overview` | Retorna los 12 KPIs, Aging, matriz de clientes, sensibilidad macro, modelos ML, alertas y recomendaciones filtrados por Sociedad, Área de Crédito, Moneda, Nivel de Riesgo, Horizonte y Escenario |
| `POST` | `/api/riesgos-financieros/simulate` | Ejecuta en tiempo real el motor de *Stress Testing* con las 8 palancas macroeconómicas y crediticias |
