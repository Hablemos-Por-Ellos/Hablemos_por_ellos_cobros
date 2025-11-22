import { DonationWizard } from "@/components/donate/donation-wizard";
import { FoundationHeader } from "@/components/donate/foundation-header";
import { HeroCard } from "@/components/donate/hero-card";

export const dynamic = "force-static";

export default function DonarPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-10 px-4 py-12">
      <FoundationHeader />
      <HeroCard />
      <DonationWizard />
      <footer className="flex flex-col items-center gap-2 rounded-4xl bg-white/80 p-6 text-center text-sm text-slate-500">
        <p>Mini-app diseñada para integrarse en el sitio Wix de la fundación.</p>
        <p>¿Preguntas? Escríbenos a contacto@hablemosporellos.org</p>
      </footer>
    </main>
  );
}
