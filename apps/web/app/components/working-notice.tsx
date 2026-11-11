/** Reusable "coming soon" notice. Text plus a bordered box (never color alone); it has no buttons because nothing here is actionable yet. */
export function WorkingNotice({ what = "Pagos, firma y adjuntos" }: { what?: string }) {
  return (
    <p role="status" className="notice working">
      <strong>{what}: estamos trabajando en ello.</strong> Todavía no está disponible; te avisaremos cuando lo esté.
    </p>
  );
}
