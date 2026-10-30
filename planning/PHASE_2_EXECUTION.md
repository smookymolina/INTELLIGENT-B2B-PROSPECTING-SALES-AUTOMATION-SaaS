# Fase 2 — identidad, tenancy, RBAC y RLS

Estado: **IN_REVIEW** (inicio 2026-10-30; implementación completa salvo P2-10 y `saas_admin`). Responsable: Claude (Tech Lead). Sin proveedores externos ni datos reales.

| ID | Trabajo | Estado | Evidencia |
|---|---|---|---|
| P2-01 | Esquema Prisma/PostgreSQL (organizations, users, memberships, sessions, audit_events) | COMPLETED | `apps/api/prisma/schema.prisma`; `migrate diff` sin deriva |
| P2-02 | Migraciones reproducibles | COMPLETED | `init_identity` + `rls_identity`; `migrate deploy` sobre BD vacía (dev y `_test`) |
| P2-03 | RLS + rol `app_runtime` sin privilegios, grants por columna, auditoría append-only | COMPLETED | `rls.int.spec.ts` (24 pruebas); con RLS desactivado en `memberships` fallan 9 |
| P2-04 | Contexto de tenant sólo desde sesión verificada | COMPLETED | `AuthGuard` + `auth_resolve_session`; esquemas zod estrictos rechazan `organization_id`; pruebas de cabeceras/query ignoradas |
| P2-05 | Auth: registro, login, logout, `/me` (scrypt, token opaco hasheado SHA-256, TTL 12 h) | COMPLETED | `tenancy.int.spec.ts` |
| P2-06 | RBAC (6 roles × 5 permisos) + guard + defensa en RLS | COMPLETED | matriz por rol (6 casos) |
| P2-07 | Organización y membresías (listar, cambiar rol, quitar; invariante "último org_admin" con bloqueo) | COMPLETED | prueba de concurrencia: 1×200 + 1×409 |
| P2-08 | Auditoría de operaciones sensibles | COMPLETED | `organization.created/updated`, `membership.*`, `auth.login/logout` con actor y `request_id` generado en servidor |
| P2-09 | Contratos API y documentación | COMPLETED | `packages/contracts`, `docs/api/IDENTITY_API.md`, `docs/architecture/MULTI_TENANCY.md` |
| P2-10 | CI con PostgreSQL real | IN_REVIEW | `ci.yml` actualizado; **no ejecutado en remoto** (sin push autorizado) |
| P2-11 | Invitaciones (token hasheado, un solo uso, caducidad 7 d, aceptación autenticada con email coincidente) | COMPLETED | migraciones `invitations`, `invitations_rls`, `invitation_accept_fix`; `invitations.int.spec.ts` 24 pruebas: no crea membresía al invitar, token sólo SHA-256, sin enumeración (404 idéntico: desconocido/caducado/revocado/usado/email distinto), un solo uso con concurrencia, email distinto no consume el token, no cambia membresías existentes, permisos por rol, aislamiento tenant (API y RLS, `token_hash` ilegible), idempotencia, tope 100 pendientes, auditoría. Suite 97/97 (BD de prueba recreada desde cero) |
| P2-12 | Límite de intentos por IP y cuenta en login (PostgreSQL, distribuido) | COMPLETED | migración `login_throttle`; `throttle.int.spec.ts` 8 pruebas (cuenta, IP, éxito reinicia, concurrencia atómica 5×401+5×429, sin enumeración, ventana, retención 24 h, sólo HMAC, tabla ilegible para `app_runtime`). Suite total 56/56 |
| P2-13 | Envelope `{code,message,details,request_id}`, `X-Request-Id`, `Idempotency-Key` (registro), OpenAPI versionado | COMPLETED | migración `idempotency`; `operational.int.spec.ts` (14 pruebas: 400/401/403/404/409/422/429/500, JSON malformado, request id forjado ignorado y presente en auditoría, replay, 422, concurrencia, liberación en fallo, cifrado en reposo) y `openapi.int.spec.ts` (3: archivo = generado, paridad exacta rutas/auth/permisos con NestJS). Suite 73/73 |
| P2-14a | Cambio de organización activa (`POST /auth/switch-organization`) | COMPLETED | `switch.int.spec.ts` 4 pruebas: rol/tenant de la nueva org, sesión previa revocada, 404 idéntico para ajena/inexistente, `organization_id` rechazado, membresía quitada, auditoría con request id. Suite 101/101 |
| P2-14b | Acceso `saas_admin` | **BLOCKED** | Decisión humana: alcance, concesión, duración e identidad no están definidos. Opciones y pruebas mínimas en `docs/security/SAAS_ADMIN_DECISION.md`. No se inventan privilegios globales |

## Evidencia de validación (2026-10-30)

- `npm run check` (db:generate, lint, tipos, `openapi:check`, 1 unit test, builds) → exit 0.
- `npm run db:test:setup -- --reset && npm run test:int` (PostgreSQL 18 local, BD de prueba recreada desde cero con las 8 migraciones): **101/101** en 7 archivos — `rls` 24, `tenancy` 24, `throttle` 8, `operational` 13, `openapi` 3, `invitations` 25, `switch` 4.
- Mutación manual (bloque anterior): RLS desactivado en `memberships` → 9 fallos; restaurado → verde.
- `docker compose config --quiet` → OK. Docker detenido al terminar.

## Riesgos abiertos

- CI remoto sin ejecutar (sin push autorizado): P2-10 sigue IN_REVIEW.
- `saas_admin` bloqueado por decisión de producto (sin soporte de plataforma por ahora).
- Sin proveedor de email: el token de invitación lo entrega el admin fuera de banda. Sin IdP/MFA/restablecimiento de contraseña (decisión de proveedor pendiente).
- Lockout de cuenta por 15 min es un DoS acotado asumido (ADR-013). `TRUST_PROXY` mal configurado permitiría falsear la IP del throttle.
- RLS sin `FORCE` (ADR-008): la aplicación nunca debe conectarse como superusuario; revisar en despliegue.
- Registro (`/auth/register`) sin throttle propio; sin límite de tamaño de sesiones por usuario.

## Criterio de salida

Cumplido en local: esquema, migraciones, RLS probado, auth, RBAC, auditoría, throttle, contrato operativo/OpenAPI, invitaciones y cambio de organización. Para pasar a COMPLETED: (1) CI remoto verde, (2) decisión humana sobre `saas_admin` o aceptarlo como deuda formal de Fase 12, (3) revisión independiente (`planning/CODEX_AUDIT_TASK.md`).
