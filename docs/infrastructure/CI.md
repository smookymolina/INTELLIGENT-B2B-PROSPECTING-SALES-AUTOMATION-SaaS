# CI reproducible (`npm run ci`)

Un solo script (`scripts/ci.mjs`, sin dependencias nuevas) ejecuta la verificación completa desde una base de datos limpia. Es el mismo que usa `.github/workflows/ci.yml`.

## Uso

```
npm run ci
```

Requisitos locales: PostgreSQL accesible en `localhost:5432` (usuario `app`), Docker arriba con el servicio `postgres` de `docker-compose.yml` (solo para el respaldo), puertos 3991/3992 libres. Termina con código distinto de 0 si cualquier etapa falla; las etapas posteriores se marcan `SKIPPED` y siempre se imprime la tabla final.

El script imprime progreso al iniciar y terminar cada etapa y un latido cada 30 s (`... still running`), y no impone ningún timeout propio: `test:int` tarda unos 5-6 min y no está colgado. Quien lo ejecute bajo un límite de tiempo debe dejar al menos 15 min. La salida completa de cada etapa queda en `ci-logs/<etapa>.log` (ignorado por git); si una etapa falla se imprimen sus últimas 40 líneas.

## Etapas

1. `preflight`: puertos 3991/3992 libres, Postgres alcanzable, Docker arriba.
2. `db-create`: `DROP/CREATE DATABASE prospecting_ci_test` (BD propia, nunca la de desarrollo ni `prospecting_test`).
3. `migrate`: `scripts/db-test-setup.mjs` aplica todas las migraciones desde cero.
4. `check`: `npm run check` (generate, lint, typecheck, openapi:check, unitarias, build).
5. `test-int`: `npm run test:int` contra la BD aislada.
6. `build`: `npm run build`.
7. `e2e-ports` + `test-e2e`: comprueba puertos y ejecuta `npm run test:e2e` (solo BD `*_test`).
8. `backup` + `backup-verify`: `npm run backup` y `npm run backup:verify` con `BACKUP_DB=prospecting_ci_test`.

Al terminar (con éxito o no) se elimina la BD `prospecting_ci_test` y los volcados `backups/prospecting_ci_test-*` que creó la ejecución.

El conteo de pruebas se parsea de las líneas `Tests  N passed (N)` de vitest (suma de los espacios de trabajo que las imprimen). En `check` suma las unitarias de contracts, mcp y web; las unitarias de la API aparecen en la salida de su propio espacio de trabajo y el valor mostrado es el que vitest reporta en esa etapa.

## Variables

| Variable | Defecto | Efecto |
|---|---|---|
| `CI_DB` | `prospecting_ci_test` | Nombre de la BD aislada (debe terminar en `_test`). |
| `CI_DB_ADMIN_URL` | `postgresql://app:app@localhost:5432/postgres` | Conexión administrativa para crear/eliminar la BD. |
| `CI_SKIP_BACKUP` | sin definir | `1` omite respaldo y verificación (GitHub Actions no tiene `docker compose exec postgres`). |
| `CI_KEEP_DB` | sin definir | `1` conserva la BD para depurar. |

## GitHub Actions

`ci.yml` levanta `postgres:18-alpine` como servicio, define `CI_DB_ADMIN_URL` y `CI_SKIP_BACKUP=1`, ejecuta `npm run ci` y sube `ci-logs/` como artefacto. No se ha ejecutado de forma remota. Límite conocido: el respaldo solo se verifica en local.

## Resultado medido (2026-11-04, Windows 11, Postgres/Redis por compose)

```
| stage         | command                                   | result | tests (passed/total) | duration |
|---------------|-------------------------------------------|--------|----------------------|----------|
| preflight     | ports 3991/3992 free + postgres reachable | OK     | -                    | 0m01s    |
| db-create     | DROP/CREATE DATABASE prospecting_ci_test  | OK     | -                    | 0m00s    |
| migrate       | node scripts/db-test-setup.mjs            | OK     | -                    | 0m04s    |
| check         | npm run check                             | OK     | 80/80                | 2m10s    |
| test-int      | npm run test:int                          | OK     | 489/489              | 5m43s    |
| build         | npm run build                             | OK     | -                    | 0m43s    |
| e2e-ports     | ports 3991/3992 free after build          | OK     | -                    | 0m00s    |
| test-e2e      | npm run test:e2e                          | OK     | -                    | 0m27s    |
| backup        | npm run backup                            | OK     | -                    | 0m02s    |
| backup-verify | npm run backup:verify                     | OK     | -                    | 0m04s    |
Total: 9m14s  =>  CI PASSED  (exit 0)
```

Una ejecución previa falló en `test-int` (451/453) porque otro proceso regeneró `docs/api/openapi.v1.json` y añadió rutas durante la corrida; con el árbol estable pasó 489/489. Tomarlo como ejemplo de que el árbol de trabajo no debe cambiar mientras corre el CI.
