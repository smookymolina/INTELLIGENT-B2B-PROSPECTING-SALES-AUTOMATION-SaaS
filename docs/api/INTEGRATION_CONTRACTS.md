# Contratos de integración

Cada adaptador declara capabilities, configuración validada, límites, errores normalizados, coste y health. `DiscoveryProvider.search(criteria)->records`; `Channel.send(message)->providerId`; `AIProvider.complete(schema,context)->structuredResult`. Nunca filtrar secreto en logs. Pruebas de contrato usan fixtures y sandbox/mock; rotación de secretos sin downtime.
