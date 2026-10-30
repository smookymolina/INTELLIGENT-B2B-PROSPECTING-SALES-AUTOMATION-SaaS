# Decisiones (ADR compacto)

| ID | Decisión | Estado | Motivo |
|---|---|---|---|
| ADR-001 | Monolito modular + workers | Propuesta | velocidad inicial y límites claros |
| ADR-002 | `organization_id` + RLS | Propuesta | aislamiento en defensa en profundidad |
| ADR-003 | Adaptadores para IA/datos/canales | Propuesta | evitar dependencia de proveedor |
| ADR-004 | Lead sólo por regla + evidencia | Propuesta | trazabilidad y revisión humana |
| ADR-005 | WhatsApp sólo API oficial | Aprobada | cumplimiento y continuidad |
| ADR-006 | npm workspaces para monorepo | Aprobada | repositorio nuevo, dependencias y contratos compartidos |
| ADR-007 | Versiones fijadas en lockfile | Aprobada | compilaciones reproducibles y control de riesgos |

Pendientes: proveedor cloud, pagos, proveedor de identidad, retención, DPA/aviso de privacidad, jurisdicciones y SLAs.

## Fase 2

| ADR-016 | Cambio de organización = nueva sesión emitida tras releer las membresías activas del usuario en BD (el slug es sólo una pista); la sesión anterior se revoca; 404 uniforme para organización ajena/inexistente. `saas_admin` queda BLOCKED hasta decisión de producto (`docs/security/SAAS_ADMIN_DECISION.md`) | Aprobada / Pendiente humana | reglas inequívocas sólo para el cambio; no se inventan privilegios globales |

| ADR-015 | Invitaciones: crear = oferta pendiente (RLS, sólo `org_admin`), token de 32 bytes mostrado una vez y guardado como SHA-256; aceptar = función `SECURITY DEFINER` atómica que consume el token sólo si el email del usuario autenticado coincide, crea la membresía y audita; todo fallo devuelve 404 idéntico; membresía existente nunca se modifica; una oferta nueva al mismo email revoca las previas; máx. 100 pendientes; sin proveedor de email aún (el admin entrega el token) | Aprobada | evita membresía forzada y enumeración (ADR-012) |

| ADR-014 | Contrato operativo: todo error es `{code,message,details,request_id}` (filtro global; 500 genérico, log sólo nombre/código); `X-Request-Id` generado en servidor en toda respuesta; `Idempotency-Key` opcional con claim atómico en PostgreSQL, resultado cifrado AES-256-GCM (24 h), 422 si cambia la petición, 409 si está en curso, fallos no se cachean; OpenAPI 3.1 generado desde zod (`docs/api/openapi.v1.json`) con prueba de paridad contra las rutas reales | Aprobada | contrato ejecutable, sin secretos en reposo; el cuerpo de éxito no incluye request id (sólo cabecera) para no alterar los DTO |

| ADR-013 | Throttle de login en PostgreSQL (no memoria ni Redis): ventana deslizante 15 min, 5 intentos/cuenta y 20/IP, bloqueo hasta que expire el intento más antiguo, 429 uniforme; HMAC-SHA256 con `HMAC_SECRET`; intento registrado atómicamente (advisory locks) antes de buscar la cuenta; bloqueados no se registran; éxito borra fallos de la cuenta; retención 24 h | Aprobada | funciona entre instancias sin dependencia nueva, auditable y probado; riesgo asumido: un atacante puede bloquear una cuenta ≤15 min (DoS acotado) |

| ID | Decisión | Estado | Motivo |
|---|---|---|---|
| ADR-008 | RLS con rol `app_runtime` (`SET LOCAL ROLE` por transacción) + `set_config` de contexto; sin `FORCE RLS` | Aprobada | sin contraseñas extra en el repo; funciones auth `SECURITY DEFINER` necesitan saltar RLS; riesgo mitigado: todo acceso pasa por `PrismaService` y hay pruebas de rol |
| ADR-009 | Prisma 7.10.1 (migraciones + cliente con `adapter-pg`); RLS/grants en migración SQL manual; zod compartido en `contracts` para validación y `@Inject` explícito | Aprobada | Prisma 8 sólo RC; Vitest/esbuild no emite metadata de decoradores, zod evita depender de ella |
| ADR-010 | Sesiones opacas (SHA-256 en BD, TTL 12 h, revocables) y contraseñas con scrypt de Node | Aprobada | sin dependencias nativas; revocación inmediata; el IdP externo sigue pendiente de decisión humana |
| ADR-011 | Roles de membresía = 6 roles de organización; `saas_admin` queda fuera de `memberships` | Aprobada | acceso de plataforma debe ser rol separado, justificado y auditado (ACCESS_CONTROL); se implementará aparte |
| ADR-012 | No añadir miembros por email directo; se hará por invitación aceptada por el invitado | Aprobada | evita membresía forzada y enumeración de usuarios entre tenants |
