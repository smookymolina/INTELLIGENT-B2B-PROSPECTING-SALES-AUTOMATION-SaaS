# Webhooks

Entradas de email/WhatsApp/proveedores: validar firma, timestamp, tenant/conexión y esquema; persistir payload mínimo cifrado, hash de dedupe e idempotencia; responder rápido, procesar por worker; reintentar y DLQ. Eventos internos mínimos: `prospect.discovered`, `message.sent`, `message.received`, `intent.assessed`, `lead.created`, `quote.sent`, `sale.recorded`.
