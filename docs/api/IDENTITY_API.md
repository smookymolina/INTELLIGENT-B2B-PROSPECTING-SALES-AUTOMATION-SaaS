# API de identidad y tenancy (v1, Fase 2)

Base `/v1`. Autenticación: `Authorization: Bearer <token>` (token opaco; sólo se guarda su SHA-256). Todo es privado salvo `@Public()`. El tenant sale de la sesión; los cuerpos son estrictos (claves desconocidas, p. ej. `organization_id`, → `400`). Esquemas en `@prospecting/contracts`.

| Método y ruta | Permiso | Notas |
|---|---|---|
| `GET /health` | público | liveness, sin datos de tenant |
| `POST /auth/register` | público | crea usuario + organización + membresía `org_admin` + sesión (201). Duplicado → 409 genérico |
| `POST /auth/login` | público | `organizationSlug` opcional, verificado contra las membresías del usuario; credenciales inválidas → 401 idéntico exista o no el email |
| `POST /auth/switch-organization` | sesión | `{organizationSlug}` verificado contra las membresías activas; devuelve sesión nueva y revoca la actual; ajena/inexistente → 404 idéntico |
| `POST /auth/logout` | sesión | revoca el token (204) |
| `GET /me` | sesión | usuario, organización, rol y permisos |
| `GET /organization` | `organization:read` | siempre la organización de la sesión |
| `PATCH /organization` | `organization:update` | `{name}`; audita nombre previo |
| `GET /organization/profile` | `organization:read` | perfil de empresa; todos los campos `null` hasta que el tenant los llene |
| `PUT /organization/profile` | `organization:update` | reemplazo total e idempotente; país ISO-2, moneda ISO-4217, zona IANA, web http(s); audita nombres de campos |
| `GET /branches` | `organization:read` | sedes activas y deshabilitadas |
| `POST /branches` | `organization:update` | nombre único por organización (sin distinguir mayúsculas) → 409 |
| `PATCH /branches/:id` | `organization:update` | editar o `status: disabled|active`; no hay DELETE |
| `GET /memberships` | `members:read` | sólo del tenant |
| `PATCH /memberships/:id` | `members:manage` | `{role}`; 404 si es de otro tenant; 409 si dejaría la org sin `org_admin` |
| `DELETE /memberships/:id` | `members:manage` | 204; el token del miembro quita acceso de inmediato |
| `POST /invitations` | `members:manage` | `{email, role}` → 201 con `token` (única vez); no crea membresía; soporta `Idempotency-Key`; 7 días; máx. 100 pendientes |
| `GET /invitations` | `members:manage` | pendientes del tenant, sin token |
| `DELETE /invitations/:id` | `members:manage` | 204; 404 si no es pendiente o es de otro tenant |
| `POST /invitations/accept` | sesión | `{token}`; sólo el usuario cuyo email coincide; cualquier otro fallo → 404 idéntico; crea la membresía (el usuario entra a la nueva organización con `login` + `organizationSlug`) |
| `GET /audit-events?limit=` | `audit:read` | 1–100, más reciente primero |

Matriz: `org_admin` todo; `campaign_manager`/`sales_manager` leen organización y miembros; `seller`/`analyst`/`viewer` sólo leen la organización. Fuente: `ROLE_PERMISSIONS`.

`POST /auth/login` aplica throttling: 5 intentos sin resolver por cuenta o 20 por IP en 15 min → `429` idéntico exista o no el email (también con contraseña correcta mientras dure el bloqueo). IP = `req.ip`; sólo se confía en `X-Forwarded-For` si `TRUST_PROXY` (nº de proxies) > 0.

## Contrato operativo

- Contrato ejecutable: `docs/api/openapi.v1.json` (generado con `npm run openapi:generate`; `npm run check` falla si está desactualizado y una prueba exige paridad exacta con las rutas reales).
- Errores: `{code, message, details, request_id}`. Códigos: `BAD_REQUEST`, `VALIDATION_FAILED` (`details.issues[{path,code}]`, sin valores enviados), `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `IDEMPOTENCY_KEY_REUSED` (422), `IDEMPOTENCY_IN_PROGRESS` (409), `RATE_LIMITED` (429 + `Retry-After`), `INTERNAL_ERROR`.
- `X-Request-Id`: generado por el servidor en toda respuesta; es el `request_id` de los errores y de la auditoría. Los valores enviados por el cliente se ignoran.
- `Idempotency-Key` (8–128 de `[A-Za-z0-9_.:-]`, opcional): soportado en `POST /auth/register`. Misma clave y misma petición durante 24 h → misma respuesta con `Idempotent-Replayed: true`; misma clave con otra petición → 422; petición simultánea → 409.
