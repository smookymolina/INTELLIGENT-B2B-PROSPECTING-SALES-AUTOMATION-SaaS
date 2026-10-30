# Fase 6 (parte interna): puerta de entrada de IA sin proveedor

Fecha: 2026-10-30. Alcance: todo lo que una IA comercial necesita **antes** de elegir proveedor. No se instaló ningún SDK ni se hizo ninguna llamada externa; el único adaptador es `mock` (determinista, sin red, con tarifas sintéticas).

| ID | Tarea | Estado | Evidencia |
|---|---|---|---|
| P6-01 | Puerta de entrada neutral: presupuesto, evidencia, guardarraíles, libro de uso | COMPLETED | Migración `ai_gateway` (`ai_budgets`, `ai_runs` append-only con RLS); permisos `ai:use` / `ai:manage`; `POST /ai/analyze`, `GET /ai/runs`, `GET /ai/usage`, `PUT /ai/budget`; `safety.spec.ts` (9) y `ai.int.spec.ts` (15); web `/ai`; E2E paso F6 (29 pasos) |
| P6-02 | Adaptadores reales (OpenAI/Anthropic) | BLOCKED | Requiere proveedor, región, DPA y credenciales aprobados |
| P6-03 | Evaluación de calidad con conjunto de oro | BLOCKED | Requiere datos reales/proveedor |

## Pipeline y garantías (ADR-028)

1. **Presupuesto**: sin fila de presupuesto la IA está bloqueada (denegar por defecto); al alcanzar el gasto del mes UTC se responde 429. El rechazo queda en el libro.
2. **Evidencia**: sólo referencias `item:<id>:v<n>` / `price:<id>` que el contrato de evidencia resuelve como *current* (aprobadas, de este tenant). Borradores, archivadas, ajenas o inexistentes nunca llegan al modelo; si ninguna sirve → 409 y registro `blocked`.
3. **Minimización**: correos, teléfonos, URLs con credenciales e identificadores largos se reemplazan antes de salir; el texto no confiable va delimitado y sin `<` `>` (no puede cerrar su envoltorio).
4. **Inyección**: patrones conocidos marcan `possible_injection` (no bloquean; fuerzan revisión humana).
5. **Prompt versionado** (`prompts.ts`): clave y versión se guardan en cada ejecución.
6. **Proveedor**: cadena primario + respaldo por entorno (`AI_PROVIDER`, `AI_FALLBACK_PROVIDER`), tiempo límite de 15 s; sin proveedor → 503 sin registrar (no hubo intento).
7. **Esquema estricto** (zod): JSON inválido o con campos extra → 503 `schema_invalid`, pero se **cobra y registra** (el proveedor ya consumió tokens).
8. **Verificación**: los `evidence_ids` citados deben estar entre los suministrados; las cifras de la respuesta deben aparecer en la evidencia o en el texto del cliente; confianza < 0,6 o petición del modelo → `needs_review`.
9. **Libro** (`ai_runs`): tokens, costo, latencia, banderas, salida validada; la aplicación sólo puede insertar y leer (sin UPDATE/DELETE). El texto crudo del cliente **no se guarda**.

La IA sólo sugiere: no hay ninguna acción automática derivada de su salida.

## Límites conocidos

- Las tarifas de `mock-1` son sintéticas; las reales saldrán del contrato con el proveedor (no se inventan).
- El presupuesto se comprueba antes de la llamada: con peticiones concurrentes puede excederse por la última tanda (sin reserva previa). Aceptado y documentado.
- Las heurísticas de PII e inyección reducen riesgo, no lo eliminan; por eso todo lo dudoso termina en revisión humana.
- `mock` se activa sólo con `AI_PROVIDER=mock`; no usarlo en producción.
