import { DonationWizard } from "@/components/donate/donation-wizard";
import { FoundationHeader } from "@/components/donate/foundation-header";
import { HeroCard } from "@/components/donate/hero-card";

export const dynamic = "force-static";

export default function DonarPage() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-10 sm:py-12 lg:py-16">
      <div className="grid gap-10 lg:grid-cols-[1.05fr,0.95fr]">
        <div className="space-y-8 lg:space-y-10">
          <FoundationHeader />
          <HeroCard />
        </div>
        <div className="space-y-8 lg:space-y-10">
          <DonationWizard />
        </div>
      </div>

      <footer className="mt-10 flex flex-col items-center gap-2 rounded-4xl bg-white/80 p-6 text-center text-sm text-slate-500 sm:mt-12">
        <p>Pasarela de pagos directa con la fundación.</p>
        <p>¿Preguntas? Escríbenos a contacto@hablemosporellos.org</p>
      </footer>
    </main>
  );
}
