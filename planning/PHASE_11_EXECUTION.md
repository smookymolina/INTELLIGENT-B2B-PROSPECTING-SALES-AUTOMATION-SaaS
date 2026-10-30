# Fase 11 — analítica

Estado: **IN_PROGRESS** (inicio 2026-10-30). Fuente: `docs/modules/ANALYTICS.md`.

| ID | Trabajo | Estado | Evidencia / siguiente paso |
|---|---|---|---|
| P11-01 | Métricas desde registros de negocio (no desde la UI): embudo con conversión, pipeline, cambios de etapa, SLA, resultados y motivos de pérdida, ventas por moneda, conciliación ventas ↔ cotizaciones aceptadas, definiciones visibles, drill-down paginado a los registros, ventana UTC explícita | COMPLETED | `analytics.spec.ts` (2) + `analytics.int.spec.ts` (escenario completo con cifras exactas, ventanas, SLA, drill-down, 6 roles, aislamiento); suite 345; E2E web 21 pasos |
| P11-02 | Atribución por campaña/canal, cohortes, paneles configurables, exportación | **BLOCKED / NOT_STARTED** | Atribución y canales dependen de F7; exportaciones requieren neutralizar fórmulas (ver ADR-020) |

## Decisiones (ADR-027)

- Sin tablas nuevas: todo se calcula en consultas de sólo lectura ejecutadas como `app_runtime`, así que RLS y el aislamiento por organización aplican a cada cifra.
- `analytics:read`: `org_admin`, `sales_manager`, `campaign_manager`, `analyst`, `viewer`. **No** para `seller` (su vista es el pipeline; el embudo mezcla ámbitos que a un vendedor no le corresponden).
- Ventana: días calendario UTC, inclusive, máx. 366 días; por defecto los últimos 30. La conversión es de **periodo** (cociente de conteos), no de cohorte; el pipeline es "a hoy". Sin SLA configurado no se mide ni se inventa (`null`).
- Cada respuesta incluye las definiciones; el drill-down devuelve los mismos registros que producen cada conteo.
