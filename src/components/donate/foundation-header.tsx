export function FoundationHeader() {
  return (
    <header className="flex flex-col items-center gap-2 text-center">
      <div className="inline-flex items-center gap-2 rounded-full bg-white/70 px-4 py-2 text-sm font-medium text-foundation-blue shadow-sm">
        <span className="text-xl">🐾</span>
        <span>Fundación Hablemos por Ellos</span>
      </div>
      <div>
        <p className="text-sm uppercase tracking-[0.3em] text-foundation-green">Programa de donación mensual</p>
        <h1 className="mt-3 text-4xl font-semibold text-slate-900">Ayuda mensual para salvar vidas</h1>
        <p className="mt-2 max-w-2xl text-lg text-slate-600">
          Crea tu suscripción solidaria en menos de dos minutos. Tu donación alimenta, rescata y brinda atención veterinaria a perros y gatos en situación vulnerable.
        </p>
      </div>
    </header>
  );
}
