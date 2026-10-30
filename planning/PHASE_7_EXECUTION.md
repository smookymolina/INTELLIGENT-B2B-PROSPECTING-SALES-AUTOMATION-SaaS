# Fase 7 (parte interna): contactos, consentimiento y campañas con canal sandbox

Fecha: 2026-10-30. Alcance: el dominio completo de una campaña de correo **sin enviar nada real**. El único adaptador es `sandbox` (memoria del proceso, idempotente por clave); `EMAIL_PROVIDER` debe fijarse explícitamente y, sin él, el envío responde 503. Cumple el criterio de aceptación de `docs/modules/EMAIL_AUTOMATION.md` («proveedor simulado en pruebas»).

| ID | Tarea | Estado | Evidencia |
|---|---|---|---|
| P7-01 | Contactos (con origen obligatorio) y libro de consentimiento append-only | COMPLETED | Migraciones `campaigns_consent` y `contacts_optout_guard`; `campaigns.int.spec.ts` (consentimiento nunca implícito, evidencia obligatoria, sin futuro, sin UPDATE/DELETE, baja sólo se revierte con consentimiento nuevo, roles y tenant); web: sección en el prospecto |
| P7-02 | Campañas: borrador → aprobada → en curso/pausa → completada/cancelada; vista previa explicable; lanzamiento idempotente; envío con revalidación; frecuencia; baja pública | COMPLETED | 11 pruebas de integración; E2E paso F7 (30 pasos); web `/campaigns`, `/campaigns/[id]`, `/unsubscribe` |
| P7-03 | Proveedor real de correo, webhooks firmados de entrega/rebote/respuesta | BLOCKED | Requiere proveedor, dominio remitente verificado, revisión legal (ADR-029) |
| P7-04 | WhatsApp (políticas Meta), secuencias multi-paso, horarios, atribución | BLOCKED | Requiere cuentas/políticas aprobadas; sin diseño comprometido |

## Reglas (ADR-029)

1. **El consentimiento nunca se infiere ni se asume.** Un contacto nace sin consentimiento; sólo cuenta el último evento del libro (`granted`/`withdrawn`) que una persona registró con evidencia y fecha. Un contacto sin evento no es alcanzable.
2. **Elegibilidad en cuatro momentos con la misma función**: vista previa, lanzamiento, **cada envío** y, como red de seguridad, un *trigger* de PostgreSQL que rechaza marcar `sent` si el contacto no está activo con consentimiento vigente o el prospecto está suprimido/descalificado. Orden fijo de motivos: baja, rebote, sin consentimiento, suprimido, ya en la campaña, enviado hace poco.
3. **Baja inmediata y sin sesión**: enlace firmado con HMAC sobre organización + contacto; la página sólo muestra una confirmación (un escáner que abra el enlace no da de baja a nadie); la API responde 204 igual para firma inválida o contacto inexistente (no es un oráculo). La baja es un evento del libro con `recorded_by = NULL` y sólo se revierte con un consentimiento nuevo registrado por una persona.
4. **Aprobación humana**: sólo `campaigns:approve` (org_admin, sales_manager); el aprobador y la hora los sella la base. Tras aprobar, el contenido es inmutable. El mensaje debe contener `{{unsubscribe_url}}` (restricción en base de datos).
5. **Idempotencia**: un intento por (campaña, contacto); relanzar o reintentar no encola ni envía dos veces; el adaptador recibe el id del intento como clave de idempotencia.
6. **Tope de frecuencia** entre campañas (`min_days_between`, 0–365, por defecto 7).

## Límites conocidos

- El audiencia es «todos los contactos de correo elegibles del tenant»; no hay segmentos todavía.
- El envío ocurre dentro de la transacción de cada intento (válido para el sandbox). Un adaptador real exige *outbox* transaccional para no enviar y luego perder el cambio de estado.
- Un intento fallido es terminal (sin reintentos automáticos todavía).
- No hay ventanas horarias ni zonas horarias del destinatario.
- La política de retención de contactos y consentimientos y la base legal por jurisdicción siguen pendientes de decisión humana (`docs/security/PRIVACY_AND_COMPLIANCE.md`).
