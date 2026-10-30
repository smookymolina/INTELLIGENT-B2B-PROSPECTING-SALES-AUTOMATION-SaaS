import type { MembershipRole } from "@prospecting/contracts";
import type { Request } from "express";

/** Identity derived exclusively from a verified session. */
export type AuthContext = Readonly<{
  sessionId: string;
  userId: string;
  organizationId: string;
  role: MembershipRole;
  requestId: string;
}>;

export type AppRequest = Request & { auth?: AuthContext; requestId?: string };
