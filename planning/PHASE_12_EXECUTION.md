# Fase 12 (parte interna): seguridad de cuenta y operación

Fecha: 2026-10-30. Alcance: sólo lo que no depende de nube, IdP, jurisdicciones ni proveedores. Lo demás de F12 sigue BLOCKED (ver `planning/PROGRESS.md`).

| ID | Tarea | Estado | Evidencia |
|---|---|---|---|
| P12-01 | Sesiones propias y cambio de contraseña | COMPLETED | Migración `account_security` (`auth_change_password`, SECURITY DEFINER, `search_path` fijo, EXECUTE sólo `app_runtime`); `GET/DELETE /auth/sessions`, `POST /auth/change-password`; `account.int.spec.ts` (9 pruebas: aislamiento entre usuarios, revocación en todas las organizaciones, throttle compartido con el login, hash ilegible para el runtime); web `/account`; E2E paso P12-01 |
| P12-02 | Disponibilidad y métricas | COMPLETED | `GET /health/ready` (503 sin detalle), `GET /health/metrics` (Prometheus; 404 salvo `METRICS_TOKEN` ≥ 32 y Bearer; etiquetas acotadas: método, patrón de ruta, clase de estado); `health.service.spec.ts`, `metrics.spec.ts`, `health.int.spec.ts` |

## Decisiones

- Cambiar la contraseña verifica la actual (hash sólo vía `auth_lookup_user`), **comparte el throttle de login** (una sesión robada no sirve para adivinar la contraseña; contrapartida aceptada: un atacante con sesión robada puede bloquear temporalmente el login de la víctima 15 min) y revoca todas las demás sesiones del usuario en todas las organizaciones, auditado sin la contraseña.
- Las métricas no registran tenant, usuario, token ni URL cruda. Una ruta inexistente se agrupa como `unmatched`.
- `METRICS_TOKEN` es opcional; sin él el endpoint no existe (404 idéntico al de token incorrecto).

## Pendiente (no resuelto aquí)

Recuperación de contraseña por correo (requiere canal), MFA/IdP (decisión de proveedor), logs estructurados con redacción, Dockerfiles de producción (no verificables sin construir imágenes), respaldo/restauración, retención y derechos del titular (siguiente bloque).

## P12-03 Guarda de roles de base de datos (COMPLETED, 2026-10-30)

Al arrancar, `PrismaService.onModuleInit` verifica con `pg_roles` que `app_runtime` existe y es NOLOGIN, no SUPERUSER y no BYPASSRLS (si no, la API no arranca). Si la **conexión** es SUPERUSER/BYPASSRLS se advierte en desarrollo y, con `REQUIRE_UNPRIVILEGED_DB_ROLE=1` (obligatorio en producción), la API se niega a arrancar: así, aunque algún código omitiera `SET LOCAL ROLE`, no habría credencial capaz de saltarse RLS. Evidencia: `role-guard.spec.ts` (3), `roles.int.spec.ts` (2: el rol real cumple; el modo producción rechaza una conexión privilegiada). Pendiente (operación): crear en producción un rol de login de mínimo privilegio con `GRANT app_runtime` y ejecutar las migraciones con otro rol distinto.

