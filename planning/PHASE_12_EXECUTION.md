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
