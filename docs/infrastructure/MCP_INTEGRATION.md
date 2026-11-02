# Integración MCP

Estado (2026-11-02): **alcance mínimo y deliberado**. El runtime no depende de MCP. Se incorpora un único servidor (`apps/mcp`) para que Claude redacte **borradores personalizados de correo y WhatsApp**; todo lo demás sigue siendo API normal. Diseño completo en `docs/architecture/AGENT_ARCHITECTURE.md` (sección 3).

Reglas (heredadas del diseño original): herramientas con alcance, validación de entrada, logs sin secretos, aislamiento de secretos, aprobación humana para acciones externas, y nunca usar MCP para evadir políticas de datos/proveedores.

- Herramientas: `get_outreach_context`, `save_message_draft`, `get_draft_status`. Sin envío ni aprobación.
- Autenticación: token de un usuario con `campaigns:manage` en `MCP_API_TOKEN`; URL en `MCP_API_URL` (por defecto `http://127.0.0.1:3001/v1`).
- Todo borrador queda `pending_review` y marcado `authorKind=mcp`; lo aprueba una persona con `campaigns:approve`.
