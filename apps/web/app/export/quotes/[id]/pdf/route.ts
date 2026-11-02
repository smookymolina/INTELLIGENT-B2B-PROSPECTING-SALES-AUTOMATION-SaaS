import { proxyPdf } from "../../../../../lib/download";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!UUID.test(id)) return new Response("Not found", { status: 404 });
  return proxyPdf(request, `/quotes/${id}/pdf`);
}
