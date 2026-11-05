# Multi-tenancy

Toda entidad de negocio porta `organization_id` inmutable; las tablas globales son explícitas. El contexto tenant se obtiene exclusivamente de sesión/API key verificada, nunca del body. Consultas ORM y políticas RLS exigen tenant; jobs y eventos incluyen tenant; almacenamiento se prefija por tenant. Admin SaaS usa rol separado, acceso justificado y auditado. Pruebas deben demostrar imposibilidad de lectura/escritura cruzada.

## Implementación (Fase 2)

1. **Identidad → contexto**: `AuthGuard` resuelve el Bearer con `auth_resolve_session` (función `SECURITY DEFINER` mínima) y produce `{userId, organizationId, role}`; nunca se lee de body/query/cabeceras.
2. **Ejecución**: cada operación corre en una transacción `SET LOCAL ROLE app_runtime` + `set_config('app.organization_id'|'app.user_id'|'app.role', …, true)`. `app_runtime` es `NOLOGIN`, no superusuario, sin `BYPASSRLS` y sin ser dueño de tablas; sin contexto no ve filas (falla cerrado).
3. **Políticas**: `organization_id = app_current_org()` en todas las tablas de tenant; escritura de membresías/organización exige `app_current_role() = 'org_admin'`; `users` sólo expone al propio usuario y miembros del tenant, sin `password_hash` (grants por columna); `organization_id` inmutable (grants por columna); `audit_events` sólo INSERT/SELECT y trigger anti UPDATE/DELETE/TRUNCATE.
4. **Invariante operativa**: la conexión de aplicación puede ser el dueño de las migraciones (FORCE solo donde ninguna función definer lo impide; ver sección final), por lo que **todo acceso de aplicación debe pasar por `PrismaService.withTenant/withoutTenant`**. En producción el rol de login no debe ser superusuario.
5. **Pruebas**: `apps/api/src/test/rls.int.spec.ts` (BD, como `app_runtime`) y `tenancy.int.spec.ts` (HTTP).

## FORCE ROW LEVEL SECURITY, excepciones y evidencia (2026-11-04)

**Modelo.** Las políticas son `TO app_runtime`. Sin `FORCE`, el dueño de la tabla las salta; con `FORCE` el dueño queda sujeto a RLS pero no tiene ninguna política aplicable (deniega todo). Un superusuario o un rol `BYPASSRLS` ignora `FORCE`; por eso el login de aplicación debe ser un rol sin esos atributos.

**Login real de aplicación.** `app_login` (`scripts/db-provision-login-role.mjs`, perfil Docker) es `NOSUPERUSER NOBYPASSRLS`, no es dueño de ninguna tabla (las migraciones las crea otro rol) y solo hereda `app_runtime`. El arranque lo vigila (`assertDbRoles`; `REQUIRE_UNPRIVILEGED_DB_ROLE=1` en producción). En desarrollo local `app` es superusuario: es aceptable solo allí.

**Con FORCE (migración `20261104100000_rls_force`, más las 6 forzadas antes):** ai_budgets, ai_runs, branches, catalog_categories, catalog_item_versions, catalog_items, intent_assessments, lead_settings, opportunities, opportunity_assignments, opportunity_notes, opportunity_tasks, organization_profiles, price_list_entries, price_lists, prospect_attributes, prospect_merges, prospect_sources, quote_counters, quote_lines, quote_settings, quotes, routing_settings, sales, score_results, scoring_model_versions, seller_pool; y campaign_schedules, sequence_*, notifications, notification_preferences.

**Sin FORCE (justificado).** Una función `SECURITY DEFINER` corre como dueño; con FORCE y dueño no superusuario vería 0 filas y rompería el flujo:

| Tabla(s) | Función / trigger definer que la necesita |
|---|---|
| organizations, users, memberships, sessions | auth_resolve_session, auth_lookup_user, auth_list_*, invitation_accept, auth_change_password |
| login_attempts | auth_login_begin / auth_login_succeeded |
| idempotency_keys | idem_begin / idem_complete / idem_release |
| invitations, audit_events | invitation_accept, privacy_purge |
| contacts, consent_events, send_attempts | consent_apply, public_unsubscribe, privacy_restrict_contact, privacy_lift_restriction, privacy_erase_contact |
| privacy_requests, erased_addresses, import_jobs, retention_policies | funciones privacy_* |
| message_drafts, draft_redaction_marks, campaigns | redact_contact_drafts, message_drafts_guard |
| prospects, leads, suppressions | suppressions_reject_leads (y los guards que dispara: leads_guard lee suppressions) |
| opportunity_stage_history | opportunities_history |
| (sin organization_id) users, organizations | idem. |

Compensación: nada de la aplicación se conecta como dueño; la regla de `withTenant/withoutTenant` y la guarda de roles siguen siendo la barrera para estas tablas. Camino para cerrarlas: mover las funciones a un rol dueño con `BYPASSRLS` dedicado (fase posterior).

**Evidencia.** `apps/api/src/test/tenant-bypass.int.spec.ts`: (a) `organization_id` y variantes en body (create/update) -> 400 sin escritura; (b) selectores en query string; (c) cabeceras X-Organization-Id/X-Tenant/etc. sin efecto; (d) barrido IDOR de todas las rutas con parámetro, todos los métodos, con IDs de otras organizaciones (nunca 2xx ni fuga); (e) token tras quitar/degradar membresía; (f) `app_runtime` sin contexto = 0 filas en todas las tablas, test que fija la lista exacta de excepciones, y un dueño NO superusuario ve 0 filas/no puede escribir en tablas FORCE. Validación adicional (manual, 2026-11-04): suite `test:int` completa con todas las tablas y funciones propiedad de un rol sin superusuario/BYPASSRLS (ver informe en el log).
