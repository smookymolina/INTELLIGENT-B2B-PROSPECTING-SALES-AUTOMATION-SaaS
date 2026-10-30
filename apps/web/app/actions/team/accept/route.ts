import type { AcceptedInvitationDto } from "@prospecting/contracts";
import { actionContext, failureCode, isResponse, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";
import { see } from "../../../../lib/session-response";

export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const result = await api<AcceptedInvitationDto>("/invitations/accept", { method: "POST", token: ctx.token, body: { token: text(ctx.form, "token", 64) } });
  // The API answers the same for invalid, expired and foreign tokens; the UI keeps that uniformity.
  return result.ok ? see("/team/accept?ok=inviteaccepted") : redirectWith("/team/accept", "error", failureCode(result));
}
