# Estrategia de prompts

Prompts son artefactos versionados con objetivo, entradas permitidas, esquema, ejemplos mínimos, evaluación y propietario. Separar instrucciones, evidencia y contenido no confiable; etiquetar éste como datos. Respuestas requieren `evidence_ids`, confianza y `needs_review`; prohibir hechos/precios ausentes. Cache sólo con clave tenant + versión + datos no sensibles autorizados.
