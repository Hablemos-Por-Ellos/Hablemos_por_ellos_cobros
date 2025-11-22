export function HeroCard() {
  return (
    <div className="relative overflow-hidden rounded-4xl bg-gradient-to-br from-white via-foundation-cream to-foundation-blue/10 p-6 shadow-card">
      <div className="flex flex-col gap-3">
        <p className="text-sm uppercase tracking-[0.3em] text-foundation-green">Historias reales</p>
        <h2 className="text-2xl font-semibold text-slate-900">Tu aporte mensual nos permite decir “sí” a más rescates.</h2>
        <p className="text-base text-slate-600">
          Alimentación, esterilizaciones, medicamentos y hogares temporales dependen de personas como tú.
        </p>
        <ul className="mt-2 grid gap-2 text-sm text-slate-600 md:grid-cols-2">
          <li className="flex items-center gap-2"><span>❤️</span>Más de 120 peludos alimentados cada mes.</li>
          <li className="flex items-center gap-2"><span>🩺</span>Clínicas veterinarias aliadas 24/7.</li>
          <li className="flex items-center gap-2"><span>🚑</span>Brigadas de rescate urbano y rural.</li>
          <li className="flex items-center gap-2"><span>🏡</span>Programas de adopción responsable.</li>
        </ul>
      </div>
      <div className="pointer-events-none absolute -right-8 bottom-0 hidden h-48 w-48 rounded-full bg-foundation-blue/10 blur-3xl md:block" />
      <div className="pointer-events-none absolute -left-6 -top-6 h-28 w-28 rounded-full bg-foundation-warm/20 blur-2xl" />
    </div>
  );
}
