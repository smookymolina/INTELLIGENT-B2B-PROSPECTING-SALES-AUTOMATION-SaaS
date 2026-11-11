# `saas_admin` — decisión de producto pendiente (P2-14, BLOCKED)

**Por qué está bloqueado.** `ACCESS_CONTROL.md` y `MULTI_TENANCY.md` sólo dicen: rol separado, acceso temporal, justificado y auditado. No definen alcance de datos, quién concede, duración, ni si se ve contenido. Implementarlo exigiría inventar privilegios globales; no se hace.

**Estado técnico actual (seguro por omisión):** `saas_admin` no existe en `memberships` ni en `ROLE_PERMISSIONS` (ADR-011); `app_runtime` no tiene `BYPASSRLS`; no hay ruta de acceso cruzado entre tenants.

## Decisiones humanas necesarias

1. **Alcance:** (a) sólo metadatos operativos (estado de organización, uso, planes, salud); (b) metadatos + lectura de contenido bajo acceso justificado; (c) además acciones de escritura (suspender, restablecer).
2. **Concesión:** (a) cuatro ojos (otro `saas_admin` o el `org_admin` del cliente aprueba); (b) ticket de soporte + aprobación interna; (c) consentimiento explícito del cliente por caso.
3. **Duración:** ventana corta fija (p. ej. 1–4 h) con renovación explícita vs. hasta revocación.
4. **Identidad:** IdP/SSO + MFA obligatoria para operadores (depende de la decisión pendiente del proveedor de identidad).
5. **Visibilidad al cliente:** cada acceso visible en el `audit_events` del tenant afectado.

## Opciones de implementación (cuando se decida)

- **A. Grants temporales (recomendada):** tabla global `support_grants` (operador, organización, motivo, alcance, `expires_at`, aprobador); la sesión de soporte entra como el tenant afectado con rol de sólo lectura, mediante `app.organization_id` fijado por el servidor desde un grant vigente (sin `BYPASSRLS`); cada petición se audita en el tenant. Reutiliza RLS y pruebas actuales.
- **B. Panel de plataforma con rol de BD distinto:** funciones `SECURITY DEFINER` por consulta (conteos/estado), sin lectura de filas de negocio. Más seguro, menos útil para soporte.
- **C. Acceso por base de datos (break-glass):** sólo procedimiento operativo documentado; sin código en la aplicación. No recomendable como camino habitual.

Pruebas mínimas al implementarlo: sin grant → 403; grant caducado → 403; grant de A no abre B; toda petición deja evento en el tenant; escritura sólo si el alcance lo permite; el operador no puede conceder grants a sí mismo.

---

## Decisión del dueño (2026-11-12) y límites implementados

1. `saas_admin` = usuario en `platform_admins`; **puede ver** datos de todas las organizaciones, **nunca escribir**.
2. Sin `BYPASSRLS` ni política general: solo funciones `SECURITY DEFINER` (`platform_admin_organizations`, `platform_admin_resource`) que exigen `platform_admins` y devuelven columnas en lista blanca (sin hashes, tokens ni credenciales SMTP).
3. Cada lectura inserta `platform_admin.read` (actor, organización, recurso, límite/offset) en el `audit_events` de la organización consultada, visible para ese cliente.
4. API: `GET /platform-admin/organizations` y `/organizations/:id/{users|prospects|leads|opportunities|quotes|campaigns}`; paginado, máximo 100. Otros métodos: 404.
5. La tabla no tiene ningún privilegio para `app_runtime`: ningún endpoint asigna ni retira el rol. Asignar por operador: `INSERT INTO platform_admins (user_id) VALUES ('<uuid>');` (revocar: `DELETE`).
6. El administrador necesita además una sesión normal (membresía en alguna organización). Pendiente: MFA/SSO obligatorio para operadores y registro de asignaciones fuera de la app.
7. Excepción documentada: política `SELECT` solo para el rol dueño en `opportunities` y `quotes` (tienen FORCE RLS); la aplicación nunca se conecta como dueño.
