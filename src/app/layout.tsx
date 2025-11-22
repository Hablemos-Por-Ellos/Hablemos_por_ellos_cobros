import type { Metadata } from "next";
import { Poppins } from "next/font/google";
import "./globals.css";

const poppins = Poppins({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-poppins" });

export const metadata: Metadata = {
  title: "Hablemos por Ellos | Donaciones mensuales",
  description:
    "Mini-app moderna para crear donaciones mensuales seguras a la fundación Hablemos por Ellos con Wompi y Supabase.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body className={`min-h-screen bg-foundation-cream text-slate-900 ${poppins.variable} font-sans`}>
        {children}
      </body>
    </html>
  );
}
