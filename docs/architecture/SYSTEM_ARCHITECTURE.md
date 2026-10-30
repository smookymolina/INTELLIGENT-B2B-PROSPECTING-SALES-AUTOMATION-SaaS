# Arquitectura del sistema

```mermaid
flowchart LR
UI[Web Next.js] --> API[API v1 / Monolito modular]
API --> PG[(PostgreSQL + RLS)]
API --> R[(Redis)]
API --> Q[BullMQ workers]
Q --> AD[Adaptadores: datos, IA, email, WhatsApp]
AD --> WH[Webhooks firmados]
WH --> API
```

Bounded modules: identidad/tenant, catálogo, prospección, enriquecimiento, IA/scoring, campañas/canales, leads/CRM, cotizaciones, analítica y administración. Cada módulo expone servicios y eventos internos tipados; sólo contratos públicos cruzan límites. Lecturas analíticas pueden derivarse de eventos, sin sustituir el registro transaccional.
