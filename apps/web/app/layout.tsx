import type { Metadata } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";

import "./globals.css";
import { WebVitals } from "./web-vitals";

/**
 * As duas famílias do Figma (`src/theme.css`: `--font-sans: 'Inter'`,
 * `--font-mono: 'DM Mono'`).
 *
 * **Por que isto importa mais do que parece.** Até aqui o app rodava na pilha
 * do sistema, e o Figma usa DM Mono em **38 lugares** — sobrancelha, pílula de
 * status, cabeçalho de tabela, eixos do gráfico, tecla de atalho, avatar,
 * identificador de métrica. Nenhuma cor conserta isso: o que dá a "cara" do
 * desenho é a alternância entre a Inter do texto e o monoespaçado dos rótulos e
 * números.
 *
 * `next/font/local` serve os WOFF2 versionados do próprio domínio. O build
 * também independe do Google: URLs sem extensão retornadas para a Inter
 * quebram o parser de fontes do Turbopack no Next 16.4.1 (next.js#99114).
 * `display: "swap"` mantém o texto legível enquanto a fonte carrega.
 *
 * Os pesos são os que o Figma usa (medido: 400, 500, 600, 700). Pedir a família
 * Inter usa um arquivo variável compartilhado pelos quatro pesos; DM Mono,
 * os dois arquivos estáticos. Origem e licenças em `fonts/README.md`.
 */
const inter = localFont({
  src: [{ path: "./fonts/inter-latin-variable.woff2", weight: "400 700", style: "normal" }],
  display: "swap",
  variable: "--sb-font-sans",
  fallback: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
});

const dmMono = localFont({
  src: [
    { path: "./fonts/dm-mono-latin-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/dm-mono-latin-500.woff2", weight: "500", style: "normal" },
  ],
  display: "swap",
  variable: "--sb-font-mono",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
});

export const metadata: Metadata = {
  title: "Speed Bikers Gestão",
  description: "Sistema interno de inteligência e gestão da Speed Bikers.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>): ReactNode {
  return (
    <html lang="pt-BR" className={`${inter.variable} ${dmMono.variable}`}>
      <body>{children}<WebVitals /></body>
    </html>
  );
}
