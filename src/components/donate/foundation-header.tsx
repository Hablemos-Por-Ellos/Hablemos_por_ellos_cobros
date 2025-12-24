import Image from "next/image";

export function FoundationHeader() {
  return (
    <header className="flex flex-col items-center gap-3 text-center sm:gap-4">
      <div className="inline-flex items-center gap-2 rounded-full bg-white/70 px-4 py-2 text-sm font-medium text-foundation-blue shadow-sm">
        <LogoMark />
        <span>Fundación Hablemos por Ellos</span>
        <span className="text-base" aria-hidden="true">🐾</span>
      </div>
      <div>
        <p className="text-sm uppercase tracking-[0.3em] text-foundation-green sm:text-base">Programa de donación</p>
        <h1 className="mt-3 text-3xl font-semibold text-slate-900 sm:text-4xl lg:text-5xl">Salva vidas con una donación</h1>
        <p className="mt-2 max-w-3xl text-base text-slate-600 sm:text-lg">
          Garantiza alimento, rescate y atención veterinaria para perros, gatos y otros peluditos.
        </p>
      </div>
    </header>
  );
}

function LogoMark() {
  return (
    <Image
      src="/hpe-logo.png"
      alt="Hablemos por Ellos"
      width={24}
      height={24}
      className="h-6 w-6"
    />
  );
}
