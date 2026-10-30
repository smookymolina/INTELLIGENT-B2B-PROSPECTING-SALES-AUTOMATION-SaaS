import { proxyCsv } from "../../../lib/download";

export async function GET(request: Request): Promise<Response> {
  return proxyCsv(request, "/prospects/export", ["status", "country"], new URL(request.url).searchParams);
}
