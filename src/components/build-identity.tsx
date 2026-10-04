import packageJson from "../../package.json";

export function BuildIdentity() {
  const date = process.env.NEXT_PUBLIC_BUILD_DATE;
  const commit = process.env.NEXT_PUBLIC_BUILD_COMMIT?.slice(0, 7);
  const formatted = date && !Number.isNaN(Date.parse(date))
    ? new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(date))
    : "sin confirmar";
  return (
    <div className="max-w-full text-xs text-slate-500">
      <p>Versión {packageJson.version} · Compilación {formatted}</p>
      <details className="mt-1">
        <summary className="cursor-pointer">{process.env.NEXT_PUBLIC_BUILD_STATE || "Local / no confirmado"}</summary>
        <p className="mt-1">Revisión {commit || "sin confirmar"}</p>
      </details>
    </div>
  );
}
