# Modelo de amenazas inicial

Estado: **Fase 1, base revisable**. Alcance: API, web, workers futuros, PostgreSQL, Redis, object storage y adaptadores.

| Amenaza | Control de diseño | Evidencia requerida |
|---|---|---|
| Lectura/escritura entre tenants | contexto confiable, `organization_id`, RLS, pruebas negativas | migración/política y test |
| Cuenta o rol comprometido | sesión segura, RBAC, MFA futura, auditoría | pruebas de autorización |
| Webhook falsificado/repetido | firma, timestamp, dedupe, idempotencia | tests de contrato |
| Secreto expuesto | vault, `.env` ignorado, rotación, escaneo | CI y revisión |
| Membresía forzada / enumeración de cuentas e invitaciones | invitación pendiente + aceptación por el titular del email, token hasheado de un uso, 404 uniforme (ADR-015) | `invitations.int.spec.ts` |
| Contenido comercial no aprobado o alterado (precios/condiciones inventados, edición de versiones aprobadas) | versiones inmutables por trigger (incluso dueño de tabla), `approved` única fuente consumible, aprobación sólo `org_admin` aplicada en API, RLS y triggers | `catalog.int.spec.ts` |
| Reintento duplicado de comandos / fuga de secretos en reposo | `Idempotency-Key` con claim atómico; claves hasheadas (HMAC) y resultados cifrados (AES-256-GCM) | `operational.int.spec.ts` |
| Fuerza bruta / credential stuffing en login | throttle PostgreSQL por IP y cuenta (ADR-013), scrypt, respuesta uniforme sin enumeración, `TRUST_PROXY` explícito | `throttle.int.spec.ts` |
| Abuso de campañas | límites, supresión, consentimiento, aprobación | reglas y pruebas |
| Inyección/exfiltración IA | contexto mínimo, datos no confiables etiquetados, JSON validado | evaluación adversarial |
| Caída/duplicación proveedor | timeout, backoff, outbox/DLQ | pruebas de reintento |

No se considera cerrado hasta implementar controles en las fases propietarias.
