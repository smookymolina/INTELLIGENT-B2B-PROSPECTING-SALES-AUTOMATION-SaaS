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
| Precios alterados tras aprobación o aprobados sobre ítems no vigentes | listas inmutables por trigger (incl. dueño), `FOR SHARE` contra ediciones concurrentes, aprobación valida ítems en API y BD, vista de consumo recalcula vigencia del ítem | `pricing.int.spec.ts` |
| Archivo de importación malicioso o desmesurado (DoS, inyección de fórmulas, aprobación encubierta) | límites de filas/columnas/campo/cuerpo, parser estricto, valores como texto, sólo borradores, todo-o-nada, mensajes sin eco | `csv.spec.ts`, `import.int.spec.ts` |
| IA o cotización que afirma precios/condiciones inexistentes o desactualizados | único canal de lectura con refs citables, `resolve` rechaza citas desconocidas/superadas/archivadas, nunca expone borradores | `evidence.int.spec.ts` |
| Contactar a quien pidió no ser contactado / confundir candidato con permiso | lista de no contactar con trigger (descalifica y bloquea calificar), `contactPermission` siempre `none`, baja sólo `org_admin` y auditada | `prospects.int.spec.ts`, E2E |
| Leads fabricados o sesgados / ignorar una baja / manipular el scoring | umbral y modelo aprobados sólo por `org_admin`, versiones inmutables, evidencia en cada puntuación y lead, atributos sin verificar no puntúan, baja automática prevalece y cierra leads, triggers contra leads de suprimidos | `scoring-leads.int.spec.ts`, E2E |
| Un vendedor accede a oportunidades/cotizaciones ajenas o reasigna | RLS por propietario (también en cotizaciones y ventas por la oportunidad), triggers que limitan al vendedor a cambiar etapa, permisos `crm:*` | `crm.int.spec.ts`, `quotes.int.spec.ts`, E2E |
| Cotización con precio/producto no aprobado, importes erróneos o editada tras enviarla | líneas sólo desde evidencia (y re-verificadas por triggers), aritmética exacta cruzada con PostgreSQL, snapshot inmutable, aprobación de descuentos ligada a líneas | `quotes.int.spec.ts`, `money.spec.ts` |
| Métricas que mezclan tenants o exponen datos fuera de alcance | consultas como `app_runtime` bajo RLS, `analytics:read` sin vendedores, ventana acotada (≤ 366 días), parámetros estrictos | `analytics.int.spec.ts` |
| Reintento duplicado de comandos / fuga de secretos en reposo | `Idempotency-Key` con claim atómico; claves hasheadas (HMAC) y resultados cifrados (AES-256-GCM) | `operational.int.spec.ts` |
| Fuerza bruta / credential stuffing en login | throttle PostgreSQL por IP y cuenta (ADR-013), scrypt, respuesta uniforme sin enumeración, `TRUST_PROXY` explícito | `throttle.int.spec.ts` |
| Abuso de campañas | límites, supresión, consentimiento, aprobación | reglas y pruebas |
| Inyección/exfiltración IA | contexto mínimo, datos no confiables etiquetados, JSON validado | evaluación adversarial |
| Caída/duplicación proveedor | timeout, backoff, outbox/DLQ | pruebas de reintento |

No se considera cerrado hasta implementar controles en las fases propietarias.

## IA (P6-01)

| Amenaza | Mitigación | Evidencia |
|---|---|---|
| Inyección de prompt desde texto de un tercero | texto delimitado como dato, sin `<` `>`, patrones marcados, nunca ejecuta acciones; todo lo dudoso a revisión humana | `safety.spec.ts`, `ai.int.spec.ts` |
| Fuga de datos personales a un proveedor | redacción de correo/teléfono/URL con credenciales/identificadores; el texto crudo no se guarda | `ai.int.spec.ts` (el proveedor espía no ve el correo) |
| Hechos o precios inventados | sólo evidencia aprobada; citas y cifras verificadas; confianza mínima | `ai.int.spec.ts` |
| Gasto descontrolado | presupuesto por tenant deny-by-default, libro de costos | `ai.int.spec.ts` |
| Manipulación del libro | tabla append-only (sin UPDATE/DELETE para la aplicación) | `ai.int.spec.ts` |
| Evidencia de otro tenant | resolución bajo RLS del tenant; ajena = no evidencia | `ai.int.spec.ts` |

## Campañas y consentimiento (P7)

| Amenaza | Mitigación | Evidencia |
|---|---|---|
| Contactar a quien no dio consentimiento | consentimiento explícito con evidencia; elegibilidad en vista previa, lanzamiento y cada envío; trigger que rechaza `sent` | `campaigns.int.spec.ts` |
| Enviar tras una baja | baja inmediata (libro + estado del contacto); revalidación por envío; trigger de respaldo | `campaigns.int.spec.ts`, E2E F7 |
| Baja falsificada o enumeración de contactos | HMAC sobre organización+contacto; 204 idéntico para válido/inválido; Origin check en el BFF | `campaigns.int.spec.ts`, E2E F7 |
| Baja accidental por escáner de correo | la página sólo confirma; hace falta un POST | E2E F7 |
| Doble envío por reintento | un intento por (campaña, contacto); clave de idempotencia al adaptador | `campaigns.int.spec.ts` |
| Contenido alterado tras la aprobación | contenido inmutable fuera de borrador; aprobador/hora sellados por la base | `campaigns.int.spec.ts` |
| Manipulación del historial de consentimiento | tabla append-only para la aplicación | `campaigns.int.spec.ts` |

