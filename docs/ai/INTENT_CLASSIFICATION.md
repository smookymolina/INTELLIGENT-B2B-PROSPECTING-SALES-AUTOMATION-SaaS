# Clasificación de intención

Taxonomía M10, salida JSON `{label,confidence,evidence_ids,needs_review}`. Umbral y reglas se configuran por tenant; clase baja/sin interés crea supresión cuando proceda; automática/irrelevante no crea lead; ambigüedad, bajo score o conflicto siempre se encola a humano. Evaluar precisión/recall por idioma/canal y registrar versión.
