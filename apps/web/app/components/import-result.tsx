type Err = { row: number; column: string | null; code: string; message: string; sku?: string | null; name?: string | null };
export type JobView = {
  id: string; mode: "dry_run" | "apply"; status: "valid" | "invalid" | "applied" | "rejected"; fileHash: string;
  totals: { rows: number; created: number; updated: number; unchanged: number; errors: number }; errors: Err[]; errorsTruncated: boolean;
};

const STATUS: Record<string, string> = {
  valid: "Validación correcta: no se cambió nada. Puedes aplicar este mismo archivo.",
  invalid: "El archivo tiene errores; no se cambió nada.",
  applied: "Importación aplicada.",
  rejected: "Importación rechazada: hay errores y no se aplicó nada (todo o nada).",
};

/** Result of a dry run / apply. Messages come from the API's fixed vocabulary and never echo cell values. */
export function ImportResult({ job }: { job: JobView }) {
  const bad = job.status === "invalid" || job.status === "rejected";
  return (
    <section aria-labelledby="result">
      <h2 id="result">Resultado</h2>
      <p role={bad ? "alert" : "status"} className={bad ? "notice error" : "notice ok"}>{STATUS[job.status]}</p>
      <dl className="stats">
        <div><dt>Filas</dt><dd>{job.totals.rows}</dd></div>
        <div><dt>Nuevas</dt><dd>{job.totals.created}</dd></div>
        <div><dt>Actualizadas</dt><dd>{job.totals.updated}</dd></div>
        <div><dt>Sin cambios</dt><dd>{job.totals.unchanged}</dd></div>
        <div><dt>Errores</dt><dd>{job.totals.errors}</dd></div>
      </dl>
      <p className="hint">Huella del archivo (SHA-256): <code>{job.fileHash.slice(0, 16)}…</code></p>
      {job.errors.length ? (
        <div className="table-wrap">
          <table>
            <caption className="sr">Errores por fila</caption>
            <thead><tr><th scope="col">Fila</th><th scope="col">Clave</th><th scope="col">Columna</th><th scope="col">Código</th><th scope="col">Detalle</th></tr></thead>
            <tbody>{job.errors.map((e, i) => <tr key={i}><td>{e.row}</td><td>{e.sku ?? e.name ?? "—"}</td><td>{e.column ?? "—"}</td><td><code>{e.code}</code></td><td>{e.message}</td></tr>)}</tbody>
          </table>
        </div>
      ) : null}
      {job.errorsTruncated ? <p className="hint">Se muestran los primeros {job.errors.length} errores de {job.totals.errors}.</p> : null}
    </section>
  );
}
