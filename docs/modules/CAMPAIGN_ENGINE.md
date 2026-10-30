# M07 Motor de campañas
Objetivo: ejecutar secuencias permitidas y medibles. Entidades: Campaign, Segment, Template, SequenceStep, Enrollment, SendAttempt, Suppression. Flujo: borrador→aprobación→audiencia elegible→encolado→evento. Reglas: frecuencia, horarios, límites, pausas, cancelación y supresión antes de cada intento. Aceptación: reintentos idempotentes, no envío tras baja y atribución por campaña.

## Estado de implementación (P7-01/P7-02)

Implementado el dominio con canal sandbox: contactos, libro de consentimiento, campañas de un correo con aprobación, vista previa explicable, lanzamiento idempotente, envío con revalidación, tope de frecuencia y baja pública firmada. Ver `planning/PHASE_7_EXECUTION.md` y ADR-029. Permisos: `campaigns:read` (org_admin, sales_manager, campaign_manager), `campaigns:manage` (ídem), `campaigns:approve` (org_admin, sales_manager). Contactos se crean/consienten con `prospects:manage`.

