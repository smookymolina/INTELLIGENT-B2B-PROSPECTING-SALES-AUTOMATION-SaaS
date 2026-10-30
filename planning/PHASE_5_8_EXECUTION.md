# Fases 5 y 8 (parte interna) — enriquecimiento/scoring y leads

Estado: **IN_PROGRESS** (inicio 2026-10-30). Fuente: `docs/modules/DATA_ENRICHMENT.md`, `docs/modules/LEAD_GENERATION.md`, `docs/ai/LEAD_SCORING.md`. Guía: `docs/modules/SCORING_AND_LEADS.md`.

| ID | Trabajo | Estado | Evidencia / siguiente paso |
|---|---|---|---|
| P5-01 | Atributos con procedencia y verificación humana (un valor distinto nunca sobrescribe: conflicto hasta verificar), modelo de reglas versionado e inmutable al aprobarse, puntuación explicable (desglose + evidencia) con historial append-only | COMPLETED | migraciones `scoring_and_leads` + `scoring_and_leads_rls`; `scoring.spec.ts` 8 unitarias (motor y clasificador) + `scoring-leads.int.spec.ts` (atributos, reglas inválidas ×8, puntuación sólo con verificados, versión obsoleta, inmutabilidad en BD, recomputar sin suprimidos) |
| P8-01 | Leads sólo por regla explícita (umbral configurado por el administrador, prospecto calificado, no suprimido, puntuación vigente) o por respuesta clasificada con intención positiva; revisión humana; creación idempotente; cierre automático por supresión | COMPLETED | evaluar idempotente, rechazo no se recrea con la misma evidencia, cierre por supresión incluso desde un rol sin revisión, triggers que impiden leads de suprimidos/no calificados; matriz de 6 roles; aislamiento. Suite 296/296; E2E web 17 pasos |
| P5-02 | Enriquecimiento con proveedores externos, merge/dedupe reversible | **BLOCKED / NOT_STARTED** | Requiere proveedores aprobados (datos) y decisión sobre deduplicación asistida |
| P8-02 | Clasificación con modelo de lenguaje y recepción de respuestas por canal (correo/WhatsApp) | **BLOCKED** | Depende de F6/F7 (proveedor de IA, canales oficiales, consentimiento). Hoy el texto se pega manualmente y se clasifica con reglas explícitas |

## Decisiones (ADR-024)

- Permisos: `scoring:manage` (`org_admin`, `sales_manager`), `scoring:approve` (`org_admin`: aprueba modelos y fija el umbral de leads), `leads:read` (todos salvo `seller`: los vendedores verán sólo leads asignados cuando exista el enrutamiento de F9), `leads:review` (`org_admin`, `sales_manager`). Atributos, puntuar y clasificar respuestas usan `prospects:manage`.
- **Sin umbral por defecto:** no se crea ningún lead por regla hasta que un administrador lo defina. No se inventan pesos ni umbrales.
- **Clasificador `rules-v1`:** diccionario explícito es/en sin acentos ni mayúsculas; baja > sin interés > respuesta automática; empate entre clases positivas, negación o ninguna coincidencia → `review` (humano). Cambiar el diccionario exige nueva versión.
- **Baja:** una respuesta de baja agrega al prospecto a la lista de no contactar (dominio, o nombre) y cierra sus leads abiertos; prevalece sobre cualquier otra intención.
- **Datos personales:** de cada respuesta se guarda un extracto de 500 caracteres y el SHA-256 del texto completo. La política de retención de extractos queda pendiente de la decisión legal (ver `docs/database/DATA_POLICIES.md`).
