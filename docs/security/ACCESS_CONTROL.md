# Control de acceso

Roles iniciales: `saas_admin`, `org_admin`, `campaign_manager`, `sales_manager`, `seller`, `analyst`, `viewer`. Permisos granulares por recurso/acción/tenant; vendedores ven asignados salvo permiso ampliado. Acceso de soporte es temporal, justificado y auditado. Catálogo (ADR-018): `catalog:read` todos; `catalog:manage` org_admin y sales_manager; `catalog:approve` org_admin. Todas las decisiones se aplican API, worker y consulta RLS; tests matriciales por rol.
