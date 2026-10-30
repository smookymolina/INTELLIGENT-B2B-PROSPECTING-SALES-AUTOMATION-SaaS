# CRM, asignación y cotizaciones (P9-01, P10-01)

Contrato: `docs/api/openapi.v1.json` (tags *CRM* y *Quotes*). Tenant siempre de la sesión.

**CRM.** `POST /opportunities` (desde un lead aceptado) · `GET /opportunities[?stage&owner=me|unassigned|<uuid>]`, `/summary`, `/{id}` (con línea de tiempo: etapas, notas y asignaciones) · `POST /{id}/stage` · `/notes` · `/assign` (userId o null = cola) · `/auto-assign` · `GET|PUT /routing/settings` (estrategia `manual|round_robin`, SLA opcional en minutos) · `GET /routing/pool`, `PUT|DELETE /routing/pool/{userId}` (capacidad y estado). El SLA se mide contra la primera pasada a `contacted`.

**Cotizaciones.** `POST /quotes` (oportunidad abierta + lista aprobada) · `PATCH` (vigencia, % de impuesto, condiciones) · `POST /{id}/lines` `{sku, quantity, discountPercent?}` → 409 con razones (`details.item`, `details.price`) si no hay evidencia · `DELETE /{id}/lines/{lineId}` · `POST /{id}/approve-discount` (admin) · `POST /{id}/send` · `POST /{id}/decision` (`accept|reject|cancel`) · `GET|PUT /quotes/settings` (límite de descuento) · `GET /sales`. Cantidades y precios viajan como cadenas decimales; los importes se devuelven con 4 decimales y los porcentajes con 2.

**Interfaz.** `/pipeline` (tablero por etapa, filtro por responsable, SLA vencido), `/pipeline/{id}` (etapa, asignación, actividad, cotizaciones, historial), `/pipeline/routing` (estrategia, SLA, pool), `/quotes/{id}` (líneas con evidencia, totales, aprobación, envío, decisión), `/sales` (cotizaciones, ventas, límite de descuento), y «Crear oportunidad» en `/leads`.
