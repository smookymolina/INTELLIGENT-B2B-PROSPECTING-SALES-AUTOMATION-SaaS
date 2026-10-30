# Flujos de datos

1. Usuario autenticado crea búsqueda; worker llama conector autorizado; normaliza, deduplica y registra fuente/fecha.
2. Enriquecimiento conserva evidencia y estado por atributo; scoring genera factores explicables.
3. Segmento elegible excluye supresiones, falta de base permitida y límites; campaña encola envío idempotente.
4. Webhook validado almacena evento, actualiza conversación y clasifica; regla crea lead o revisión humana; routing notifica vendedor.
5. Pipeline/cotización/venta emiten eventos para métricas y coste atribuido.
