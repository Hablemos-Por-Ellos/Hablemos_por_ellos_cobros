export function FoundationHeader() {
  return (
    <header className="flex flex-col items-center gap-2 text-center">
      <a
        href="/donar"
        className="inline-flex items-center gap-2 rounded-full bg-white/70 px-4 py-2 text-sm font-medium text-foundation-blue shadow-sm"
      >
        <span className="text-xl">🐾</span>
        <span>Fundación Hablemos por Ellos</span>
      </a>
      <div>
        <p className="text-sm uppercase tracking-[0.3em] text-foundation-green">Programa de donación</p>
        <h1 className="mt-3 text-4xl font-semibold text-slate-900">Salva vidas con una donación</h1>
        <p className="mt-2 max-w-2xl text-lg text-slate-600">
          Garantiza alimento, rescate y atención veterinaria para perros y gatos.
        </p>
      </div>
    </header>
  );
}
