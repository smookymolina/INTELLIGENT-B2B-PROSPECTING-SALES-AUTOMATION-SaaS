import type { MeDto } from "@prospecting/contracts";
import { redirect } from "next/navigation";
import { api } from "./api";
import { readSessionToken } from "./session";

export type Authed = { token: string; me: MeDto };

/** Server-component guard: no cookie or a rejected token sends the visitor to /login; an unreachable API surfaces the error boundary. */
export async function requireSession(): Promise<Authed> {
  const token = await readSessionToken();
  if (!token) redirect("/login");
  const result = await api<MeDto>("/me", { token });
  if (result.ok) return { token, me: result.data };
  if (result.status === 401) redirect("/login?error=expired");
  throw new Error("The API is not reachable");
}
