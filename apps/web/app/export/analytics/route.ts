import { proxyCsv } from "../../../lib/download";

export async function GET(request: Request): Promise<Response> {
  return proxyCsv(request, "/analytics/events/export", ["metric", "from", "to"], new URL(request.url).searchParams);
}
