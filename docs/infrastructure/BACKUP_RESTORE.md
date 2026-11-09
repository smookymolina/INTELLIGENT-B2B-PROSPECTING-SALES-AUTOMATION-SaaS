# Respaldo y restauracion de PostgreSQL (P12-05)

Alcance: BD de desarrollo del `docker-compose.yml` (servicio `postgres`). Sin dependencias nuevas; `pg_dump`/`pg_restore` se ejecutan dentro del contenedor.

## Uso

```
npm run backup                      # BACKUP_DB=prospecting, BACKUP_KEEP=7
npm run backup:verify               # restaura el dump mas reciente en prospecting_restore_check y compara
node scripts/restore-verify.mjs --file backups/<db>-<UTC>.dump [--manifest <json>]
node scripts/restore-verify.mjs --target <db> --yes [--force]   # restauracion real (explicita)
```

- `backup` genera `backups/<db>-<UTC>.dump` (formato custom `-Fc`) y `.json` con sha256, tamano, fecha, version de pg_dump, ultima migracion de `_prisma_migrations` y conteo exacto de filas por tabla de `public`. Rota solo los dumps de esa misma BD (conserva `BACKUP_KEEP`). `backups/` esta en `.gitignore` y `.dockerignore`.
- `backup:verify` comprueba el sha256, restaura en una BD temporal, compara conteos y ultima migracion con el manifiesto, imprime resumen y **siempre** elimina la BD temporal. Sale con codigo 1 si algo difiere.
- Nunca restaura sobre una BD no temporal sin `--target <db> --yes`, ni sobre una no vacia sin `--force`. No se usan contrasenas (socket local del contenedor como usuario `app`).

## Medidas (esta maquina, 2026-11-02, Docker Desktop, 45 tablas, 372 filas, dump de 346 686 bytes)

| Medida | Valor |
|---|---|
| Duracion del backup | ~1,5 s |
| Restauracion + verificacion completa (RTO de la BD de desarrollo) | ~3,4 s |
| RPO | Igual al tiempo desde el ultimo `npm run backup`: no hay planificacion automatica, asi que hoy es manual y sin garantia |

El RTO crecera con el volumen de datos; el valor es de una BD diminuta y no extrapolable a produccion.

Pruebas realizadas: verificacion correcta; manifiesto alterado (un conteo +1) -> falla con codigo 1 y la BD temporal se elimina igualmente; `--target prospecting` sin `--yes` y con `--yes` sin `--force` -> rechazado. `prospecting` quedo intacta (45 tablas, 372 filas antes y despues).

## Limitaciones

- El dump vive en disco local. Con `BACKUP_ENCRYPTION_KEY` (64 hex) se cifra con AES-256-GCM (`.dump.enc`, manifiesto `encrypted: true`); sin la variable queda en claro. Clave incorrecta o archivo alterado: `backup:verify` falla ("unable to authenticate data"). Guardar la clave fuera del repositorio y de la maquina de respaldos; perderla = perder el respaldo.
- **No hay copia fuera de la maquina**: perder el disco o el volumen Docker pierde datos y respaldos.
- **No cubre Redis** (colas BullMQ/estado efimero); se asume reconstruible.
- Los conteos del manifiesto se toman justo antes del dump; con escrituras concurrentes puede haber falsos negativos.
- Solo valida conteos y migracion, no el contenido fila a fila ni las politicas RLS tras restaurar.
- Los roles de cluster (`app_runtime`, `app_login`) no se respaldan; deben existir antes de restaurar.

## Falta para produccion

Gestion de la clave en un KMS, almacenamiento remoto con retencion e inmutabilidad, ejecucion programada con alerta de fallo, backup continuo/PITR (WAL) para un RPO real, restauracion de prueba periodica automatizada con metricas, respaldo de roles y de secretos, y runbook de recuperacion ante desastre.
