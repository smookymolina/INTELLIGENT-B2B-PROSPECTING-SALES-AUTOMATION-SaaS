# Worker de operacion asincrona

Estado: implementado con **canal sandbox (mock)**: ningun envio sale a un proveedor real. Decision: ADR-031 (cola en PostgreSQL; BullMQ/Redis queda como evolucion).

## Que hace
- Un envio de secuencia **solo** ocurre dentro del worker (`SequencesService.runDue`). Ya no existe un endpoint HTTP de envio (eliminado 2026-11-04).
- Cada tick: (1) planifica (una vez por ventana) un `notifications.scan_due` por organizacion y un `sequence.run_due` por campana `running` con secuencia; (2) reclama trabajos vencidos con lease; (3) ejecuta cada uno con el contexto tenant de esa organizacion (`withTenant`, rol `app_runtime`, RLS vigente) como su `org_admin` activo; (4) actualiza metricas.
- `runDue` vuelve a comprobar en cada paso: campana lanzada/aprobada, consentimiento, baja, supresion, tope de frecuencia y ventana horaria.

## Ejecutar
`npm run worker --workspace=@prospecting/api` (o `worker:dev` con recarga). Sin puerto HTTP. SIGTERM/SIGINT: termina el trabajo en curso, no toma mas, cierra la BD (tope duro 30 s; un trabajo huerfano se recupera cuando expire su lease). Varias instancias son seguras (`SKIP LOCKED`).

| Variable | Defecto | Uso |
|---|---|---|
| `DATABASE_URL`, `HMAC_SECRET`, `ENCRYPTION_KEY` | obligatorias | las mismas que la API |
| `WORKER_POLL_MS` | 5000 | pausa entre ticks |
| `WORKER_PLAN_EVERY_MS` | 60000 | tamano de la ventana de planificacion (idempotencia) |
| `WORKER_BATCH` | 5 | trabajos reclamados por tick (limite por tick) |
| `WORKER_LEASE_SECONDS` | 120 | duracion del lease; debe superar el trabajo mas largo |
| `WORKER_MAX_ATTEMPTS` | 5 | intentos antes de DLQ |
| `WORKER_BACKOFF_BASE_MS` / `_CAP_MS` | 30000 / 900000 | reintento = base * 2^(intento-1), con tope |
| `WORKER_RUN_DUE_LIMIT` | 50 | inscripciones por ejecucion de `runDue` |
| `WORKER_METRICS_FILE` | vacio | ruta del archivo de metricas Prometheus |
| `LOG_FORMAT=json` | | logs estructurados (sin PII; mensajes `event=... type=... job=...`) |

## Garantias
- **Sin doble envio por reintento:** cada inscripcion avanza en la misma transaccion que crea su entrega; `(enrollment, step)` es unico en `sequence_deliveries` y el canal es idempotente por clave. Un reintento solo procesa lo que sigue pendiente.
- **Sin duplicar trabajos:** unico por `(organizacion, tipo, clave de ventana)`.
- **Sin bucles:** tope `max_attempts`; errores 4xx (salvo 429) y cargas invalidas van directo a `dead`; un lease vencido con intentos agotados va a `dead`.
- **Aislamiento:** `jobs` tiene RLS + FORCE; los tenants solo leen lo suyo y solo `org_admin` puede reencolar (UPDATE restringido por columna). Reclamar/terminar son funciones `SECURITY DEFINER` con fencing por `locked_by`.
- `last_error` se redacta (correos, tokens, UUID, numeros largos) y se trunca antes de guardarse.

## Metricas (archivo `WORKER_METRICS_FILE`, formato textfile collector)
`worker_jobs_total{type,outcome}`, `worker_job_retries_total{type}`, `worker_job_duration_seconds_sum/_count{type}`, `worker_queue_jobs{state}` (`state="dead"` = profundidad de la DLQ), `worker_last_tick_timestamp_seconds`, `worker_uptime_seconds`. Alerta sugerida: `worker_queue_jobs{state="dead"} > 0` o tick sin avanzar > 5 min.

## Auditoria y API admin (permiso `jobs:manage`, solo `org_admin`)
`GET /admin/jobs?state=dead|all|...`, `GET /admin/jobs/stats`, `POST /admin/jobs/{id}/requeue`. Eventos de auditoria: `job.retry_scheduled`, `job.dead`, `job.requeued`.

## Runbook DLQ
1. `GET /admin/jobs` (por defecto `dead`): leer `type`, `lastError` (redactado) y `attempts`.
2. Corregir la causa (proveedor, datos de la campana, despliegue). Un `4xx` suele ser campana cancelada o payload invalido: normalmente no hay que reencolar.
3. `POST /admin/jobs/{id}/requeue` (vuelve a `queued`, intentos a 0). Es seguro: repite trabajo idempotente.
4. Si sigue cayendo en DLQ, pausar la campana y escalar. No editar `jobs` a mano.

## Retencion y limites
- `jobs` crece (1 trabajo por campana/org/ventana). **No hay purga automatica** hasta que el cliente decida retencion; mientras tanto, vigilar tamano. Propuesta pendiente de decision: borrar `succeeded` con mas de 30 dias y conservar `dead` 180 dias.
- Sin cron externo: la planificacion vive en el propio worker (un proceso basta; si no hay worker no se planifica nada). Sin Redis/BullMQ. Un worker caido deja los envios en pausa, no los pierde.
- No existe endpoint HTTP que envie: se elimino `POST /campaigns/{id}/sequence/run-due` (2026-11-04); solo el worker llama a `SequencesService.runDue`.
