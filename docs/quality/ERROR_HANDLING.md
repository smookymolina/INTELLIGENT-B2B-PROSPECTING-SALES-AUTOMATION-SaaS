# Manejo de errores

Errores tipados con código estable, `request_id`, causa interna protegida y mensaje accionable. Operaciones externas usan timeout, retry con backoff/jitter cuando seguro, idempotencia, circuit breaker y DLQ. No reintentar 4xx semánticos ni bajas. Alertar por fallos repetidos/colas atrasadas; runbook para replay controlado.
