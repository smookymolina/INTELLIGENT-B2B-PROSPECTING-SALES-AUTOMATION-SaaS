# @prospecting/mcp

Servidor MCP (stdio) para que Claude redacte borradores de correo/WhatsApp sobre la API. Solo 3 herramientas: `get_outreach_context`, `save_message_draft`, `get_draft_status`. No envia, aprueba ni rechaza: los borradores nacen `pending_review` y los aprueba una persona en el producto.

## Variables de entorno

- `MCP_API_TOKEN` (obligatoria): token Bearer de un usuario con `campaigns:manage`. Solo por entorno, nunca en argumentos.
- `MCP_API_URL` (opcional): por defecto `http://127.0.0.1:3001/v1`. Hosts no locales se rechazan salvo `MCP_ALLOW_REMOTE=1`.

## Registro en Claude

```bash
npm run build --workspace=@prospecting/mcp
```

```json
{
  "mcpServers": {
    "prospecting-drafts": {
      "command": "node",
      "args": ["C:/ruta/al/repo/apps/mcp/dist/server.js"],
      "env": {
        "MCP_API_URL": "http://127.0.0.1:3001/v1",
        "MCP_API_TOKEN": "<token-del-usuario>"
      }
    }
  }
}
```

## Pruebas

- `npm test --workspace=@prospecting/mcp`: unitarias.
- `TEST_DATABASE_URL=postgresql://app:app@localhost:5432/<base>_test npm run test:int --workspace=@prospecting/mcp`: extremo a extremo (API real + servidor por stdio).

## Configuración segura

- El token debe pertenecer a un usuario con rol `campaign_manager`: puede crear borradores pero NO tiene `campaigns:approve`. Nunca uses `org_admin` ni `sales_manager`.
- La aprobación la hace siempre una persona, desde la API/producto; este MCP no aprueba ni envía.
- La cabecera `X-Client-Kind: mcp` es solo una etiqueta de procedencia, no una garantía de seguridad: el control real es el rol del token.
- Todo texto de terceros (prospecto, contacto, evidencias, cuerpo del borrador, nota del revisor) se devuelve dentro de `untrustedData` junto a un `notice`: son datos, nunca instrucciones.
