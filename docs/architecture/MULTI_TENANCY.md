# Multi-tenancy

Toda entidad de negocio porta `organization_id` inmutable; las tablas globales son explícitas. El contexto tenant se obtiene exclusivamente de sesión/API key verificada, nunca del body. Consultas ORM y políticas RLS exigen tenant; jobs y eventos incluyen tenant; almacenamiento se prefija por tenant. Admin SaaS usa rol separado, acceso justificado y auditado. Pruebas deben demostrar imposibilidad de lectura/escritura cruzada.

## Implementación (Fase 2)

1. **Identidad → contexto**: `AuthGuard` resuelve el Bearer con `auth_resolve_session` (función `SECURITY DEFINER` mínima) y produce `{userId, organizationId, role}`; nunca se lee de body/query/cabeceras.
2. **Ejecución**: cada operación corre en una transacción `SET LOCAL ROLE app_runtime` + `set_config('app.organization_id'|'app.user_id'|'app.role', …, true)`. `app_runtime` es `NOLOGIN`, no superusuario, sin `BYPASSRLS` y sin ser dueño de tablas; sin contexto no ve filas (falla cerrado).
3. **Políticas**: `organization_id = app_current_org()` en todas las tablas de tenant; escritura de membresías/organización exige `app_current_role() = 'org_admin'`; `users` sólo expone al propio usuario y miembros del tenant, sin `password_hash` (grants por columna); `organization_id` inmutable (grants por columna); `audit_events` sólo INSERT/SELECT y trigger anti UPDATE/DELETE/TRUNCATE.
4. **Invariante operativa**: la conexión de aplicación puede ser el dueño de las migraciones (RLS sin `FORCE` para que las funciones auth funcionen), por lo que **todo acceso de aplicación debe pasar por `PrismaService.withTenant/withoutTenant`**. En producción el rol de login no debe ser superusuario.
5. **Pruebas**: `apps/api/src/test/rls.int.spec.ts` (BD, como `app_runtime`) y `tenancy.int.spec.ts` (HTTP).
