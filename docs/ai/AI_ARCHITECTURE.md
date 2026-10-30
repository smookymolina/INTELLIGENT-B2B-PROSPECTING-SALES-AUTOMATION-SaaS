# Arquitectura IA

Orquestador neutral selecciona proveedor/modelo por capability, coste, región y política tenant; adaptadores OpenAI/Anthropic normalizan requests. Pipeline: recuperar sólo catálogo/evidencia relevante→prompt versionado→salida JSON validada→guardar evaluación/uso→acción con regla determinista. Guardrails: redacción/minimización PII, límites, timeout/fallback, detección de inyección y revisión humana.
