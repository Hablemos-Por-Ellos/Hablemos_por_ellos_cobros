import Image from "next/image";
import Link from "next/link";

export default function HomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-16">
      <div className="max-w-2xl rounded-3xl bg-white/80 p-10 text-center shadow-card">
        <div className="mb-4 flex items-center justify-center">
          <Image
            src="/hpe-logo.png"
            alt="Hablemos por Ellos"
            width={64}
            height={64}
            className="h-12 w-12"
            priority
          />
        </div>
        <p className="text-sm uppercase tracking-[0.3em] text-foundation-blue">Hablemos por Ellos</p>
        <h1 className="mt-4 text-3xl font-semibold text-slate-900">
          Donaciones
        </h1>
        <p className="mt-3 text-lg text-slate-600">
          Hola Humano, bienvenido al portal de ayuda de la sucursal del cielo, FUNDACIÓN HABLEMOS POR ELLOS. Tu apoyo está a un CLICK
        </p>
        <Link
          href="/donar"
          aria-label="Ir a la página de donación"
          className="mt-8 inline-flex items-center justify-center rounded-full bg-foundation-blue px-6 py-3 text-lg font-semibold text-white shadow-lg transition hover:-translate-y-0.5 hover:bg-foundation-blue/90"
        >
          Donar ahora
        </Link>
      </div>
    </main>
  );
}
