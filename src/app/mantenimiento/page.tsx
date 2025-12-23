import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sitio en mantenimiento | Hablemos por Ellos",
};

export default function MaintenancePage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-16">
      <div className="max-w-xl rounded-3xl bg-white/90 p-10 text-center shadow-card">
        <p className="text-sm uppercase tracking-[0.3em] text-foundation-green">Hablemos por Ellos</p>
        <h1 className="mt-4 text-3xl font-semibold text-slate-900">Sitio en mantenimiento</h1>
        <p className="mt-3 text-base text-slate-600">
          Estamos realizando ajustes para mejorar la experiencia de donaciones.
        </p>
        <p className="mt-3 text-sm text-slate-500">Gracias por tu paciencia. Vuelve pronto.</p>
      </div>
    </main>
  );
}
