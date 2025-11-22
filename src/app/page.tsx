import Link from "next/link";

export default function HomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-16">
      <div className="max-w-2xl rounded-3xl bg-white/80 p-10 text-center shadow-card">
        <p className="text-sm uppercase tracking-[0.3em] text-foundation-green">Fundación Hablemos por Ellos</p>
        <h1 className="mt-4 text-3xl font-semibold text-slate-900">
          Módulo de donaciones mensuales
        </h1>
        <p className="mt-3 text-lg text-slate-600">
          Este mini-sitio está diseñado para ser embebido en la página principal hecha en Wix.
          Usa el botón inferior para ver el flujo completo de donación.
        </p>
        <Link
          href="/donar"
          className="mt-8 inline-flex items-center justify-center rounded-full bg-foundation-blue px-6 py-3 text-lg font-semibold text-white shadow-lg transition hover:-translate-y-0.5 hover:bg-foundation-blue/90"
        >
          Ir al flujo /donar
        </Link>
      </div>
    </main>
  );
}
