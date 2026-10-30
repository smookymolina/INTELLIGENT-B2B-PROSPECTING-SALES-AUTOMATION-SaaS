# Fases 9 y 10 — CRM, asignación y cotizaciones

Estado: **IN_PROGRESS** (inicio 2026-10-30). Fuente: `docs/modules/CRM.md`, `LEAD_ROUTING.md`, `QUOTATIONS.md`. Guía: `docs/modules/CRM_AND_QUOTES.md`.

| ID | Trabajo | Estado | Evidencia / siguiente paso |
|---|---|---|---|
| P9-01 | Oportunidades desde leads aceptados, máquina de etapas, historial escrito por la base, notas/actividades, asignación manual / round-robin reproducible / cola, SLA de primera atención, visibilidad del vendedor por RLS | COMPLETED | migración `crm`; `crm.int.spec.ts` 17 pruebas (incluye que la tabla de transiciones del contrato coincide con la función de PostgreSQL para las 81 combinaciones); suite 333 |
| P10-01 | Cotizaciones sólo desde evidencia aprobada, aritmética decimal exacta verificada por PostgreSQL, aprobación de descuentos, congelamiento al enviar, aceptación → venta y oportunidad ganada | COMPLETED | migración `quotes`; `quotes.int.spec.ts` + `money.spec.ts`; prueba cruzada con importes arbitrarios; E2E web de 20 pasos |
| P9-02 | Tareas con vencimiento, notificaciones de asignación/SLA, catálogo de motivos de pérdida | NOT_STARTED | Notificaciones dependen de canales (F7) |
| P10-02 | PDF versionado de la cotización, impuestos múltiples/catálogo fiscal, firma electrónica, pagos | **BLOCKED / NOT_STARTED** | Requiere decisiones fiscales, jurisdicción y proveedores |

## Decisiones (ADR-025, ADR-026)

- **Permisos CRM:** `crm:read` (los 6 roles), `crm:work` (`org_admin`, `sales_manager`, `seller`), `crm:manage` (`org_admin`, `sales_manager`). Un **vendedor sólo ve y modifica las oportunidades asignadas a él** (RLS), y sólo puede cambiar la etapa; no puede reasignar ni crear (trigger + permisos).
- **Oportunidad:** nace de exactamente un lead `accepted` de un prospecto no suprimido; etapas `new → contacted → qualification → quote_requested/quote_sent/negotiation → won|lost`, `future`; `lost` exige motivo; cerradas son inmutables. El historial lo inserta un trigger (nadie puede omitirlo ni editarlo).
- **Asignación:** sin configuración es manual y sin SLA. Round-robin: menos oportunidades abiertas, luego la asignación más antigua, luego el id; respeta capacidad; si nadie puede, queda en la cola. Cada decisión guarda el listado de candidatos.
- **Permisos de cotizaciones:** `quotes:read` (todos salvo `campaign_manager`), `quotes:manage` (`org_admin`, `sales_manager`, `seller`), `quotes:approve` (`org_admin`: aprueba descuentos y fija el límite). La visibilidad de las cotizaciones sigue a la oportunidad.
- **Cotización:** sólo con lista de precios aprobada (moneda de la lista) y líneas construidas con el contrato de evidencia (precio y versión aprobados; el precio nunca se teclea). Aritmética en BigInt a 4 decimales con redondeo half-up idéntico a `round(numeric,4)`; al enviar, la base recalcula y compara todo. Descuento > límite (por defecto 0 %) exige aprobación de `org_admin` ligada a las líneas exactas (cualquier cambio la retira). Al enviar se re-verifica que cada línea siga respaldada por evidencia aprobada, se congela y la oportunidad pasa a `quote_sent` si la transición es válida. Impuesto: porcentaje explícito (sin valor por defecto).
- **Aceptación:** crea la venta (inmutable) vinculando lead → oportunidad → cotización → venta y gana la oportunidad; una cotización vencida no puede aceptarse.

## P9-02 Tareas de seguimiento (COMPLETED)

Migración `crm_tasks` (tabla `opportunity_tasks`, RLS con la visibilidad de la oportunidad, trigger `opportunity_tasks_guard`: nace abierta, no se agregan a oportunidades cerradas, responsable válido, sólo open → done/cancelled, `completed_at/by` sellados por la base). API: `POST /opportunities/:id/tasks`, `GET /opportunities/:id/tasks`, `GET /tasks` (estado, responsable, vencidas, keyset por vencimiento), `POST /tasks/:id/complete|cancel`. Reglas: el vendedor sólo ve y trabaja tareas de sus oportunidades y sólo se asigna a sí mismo; lectores no escriben. Evidencia: `tasks.int.spec.ts` (6), E2E paso P9-02, web `/tasks` y sección en el detalle de la oportunidad. Pendiente: recordatorios (requieren canal).

