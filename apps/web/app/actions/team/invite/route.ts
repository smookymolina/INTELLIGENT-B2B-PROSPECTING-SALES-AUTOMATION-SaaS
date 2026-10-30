import { randomUUID } from "node:crypto";
import { MEMBERSHIP_ROLES, type InvitationCreatedDto } from "@prospecting/contracts";
import { actionContext, failureCode, isResponse, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c] as string);

/**
 * The one-time invitation token is shown ONCE, directly in this no-store HTML response. It is never placed in a URL,
 * redirect, cookie or log, so it cannot leak through history, Referer or proxies.
 */
export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const role = text(ctx.form, "role", 30);
  if (!(MEMBERSHIP_ROLES as readonly string[]).includes(role)) return redirectWith("/team", "error", "input");
  const result = await api<InvitationCreatedDto>("/invitations", {
    method: "POST", token: ctx.token, body: { email: text(ctx.form, "email", 254), role }, headers: { "idempotency-key": randomUUID() },
  });
  if (!result.ok) return redirectWith("/team", "error", failureCode(result));
  const i = result.data;
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Invitación creada</title></head><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem"><main><h1>Invitación creada</h1><p role="status">Entrega este código a <strong>${esc(i.email)}</strong> por un canal seguro. <strong>Se muestra una sola vez</strong> y no se puede recuperar.</p><p><code id="invitation-token" style="word-break:break-all;display:block;padding:.75rem;border:1px solid #888">${esc(i.token)}</code></p><p>Rol: ${esc(i.role)} · Vence: ${esc(i.expiresAt)}</p><p><a href="/team">Volver al equipo</a></p></main></body></html>`;
  return new Response(html, { status: 201, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}
