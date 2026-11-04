# Runbooks de operacion (P12-06)

Alcance: entorno local/Compose. No hay nube, IdP ni alertas externas (BLOCKED, ver `context/CURRENT_STATUS.md`). Lo siguiente es lo que se puede ejecutar hoy y lo que debe configurarse cuando exista infraestructura.

## Senales disponibles

| Senal | Donde | Uso |
|---|---|---|
| Liveness | `GET /health` | proceso vivo |
| Readiness | `GET /health/ready` | 503 sin detalle si la BD no responde |
| Metricas | `GET /health/metrics` (404 salvo `METRICS_TOKEN` >= 32 caracteres; `Authorization: Bearer`) | `http_requests_total`, `http_request_duration_seconds_sum`, `process_uptime_seconds`; etiquetas acotadas (metodo, patron de ruta, estado) |
| Logs | stdout JSON estructurado | un renglon por peticion, sin cuerpos ni credenciales |

### Alertas minimas recomendadas (a configurar cuando exista un monitor)
- Readiness distinto de 200 durante > 1 min.
- Proporcion de respuestas 5xx / total > 1 % en 5 min (con `http_requests_total`).
- `process_uptime_seconds` reiniciandose (> 3 reinicios en 15 min).
- Ultimo respaldo verificado con mas de 24 h de antiguedad (hoy no existe planificador: ver Respaldo).

## R1. API no responde o readiness 503
1. `docker info` (Docker Desktop abierto) y `docker compose ps`: postgres y redis `healthy`.
2. `docker compose up -d` si estan detenidos; esperar a `healthy`.
3. Reiniciar la API (`npm run dev:api` o el servicio `api` del perfil `app`). La API arranca con guarda de roles de BD: si falla, el mensaje indica el rol faltante o con privilegios de mas.
4. Si persiste: revisar la primera linea de error del log; no reintentar a ciegas.

## R2. Redis caido
Medido (2026-11-04): con Redis detenido (`docker compose stop redis`) la API reinicia y `/health/ready` responde 200. Hoy **ningun codigo de la API usa Redis ni BullMQ** (sin worker ni colas): no hay efecto observable. Cuando se agregue el worker (secuencias `run-due`, `scanDue` de notificaciones) este runbook y su prueba deben actualizarse: el trabajo pendiente vive en la BD, que es la fuente de verdad. Accion actual: `docker compose up -d redis`.

## R3. Respaldo y restauracion
- Respaldo: `npm run backup` (genera `backups/<db>-<UTC>.dump` + manifiesto).
- Verificacion periodica (hoy manual; ejecutar al menos diario y antes de cada migracion): `npm run backup:verify`. Debe terminar en codigo 0; cualquier diferencia de conteos o de ultima migracion es incidente.
- Restauracion real: `node scripts/restore-verify.mjs --target <db> --yes` (BD vacia; `--force` solo con decision explicita). Detalle y medidas en `BACKUP_RESTORE.md`.
- Limitaciones: sin cifrado, sin copia externa, sin Redis.

## R4. Migracion fallida
1. No editar migraciones ya aplicadas. Respaldar (`npm run backup`) antes de migrar.
2. Si falla en desarrollo: restaurar el respaldo en BD vacia y corregir con una migracion nueva.
3. Confirmar `_prisma_migrations` sin filas `failed` antes de arrancar la API.

## R5. Sospecha de fuga entre organizaciones
1. Pausar la API.
2. Ejecutar `npm run test:int` (incluye pruebas de aislamiento por tabla) y revisar la auditoria (`audit_log`) del periodo.
3. Verificar que la API usa `app_runtime`/`app_login` (no el rol privilegiado); la guarda de arranque lo comprueba.
4. Notificar al responsable de privacidad (pendiente de designar: decision humana).

## R6. Solicitud de un titular (acceso, restriccion, borrado)
Usar `/privacy/*` (o la pantalla `/privacy`): simular antes de aplicar; el borrado redacta borradores y deja huella HMAC. Los plazos de retencion no tienen valor por defecto: sin decision del cliente no se purga nada.

## R7. Cambio de rol o salida de un miembro
Quitar la membresia (`/team`) revoca el acceso a la organizacion (cubierto por `tenancy`/`roles` en `test:int`). Revisar tareas y oportunidades asignadas a esa persona.

## Pendiente (BLOCKED por decision humana)
Planificador de respaldos y copia externa cifrada, monitor y canal de alertas, responsable de guardia, objetivos RTO/RPO de produccion, IdP, nube.
