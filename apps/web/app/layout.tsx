import type { Metadata } from "next";
import { DM_Mono, Inter } from "next/font/google";
import type { ReactNode } from "react";

import "./globals.css";

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
 * `next/font` baixa as fontes no BUILD e as serve do próprio domínio — não há
 * requisição ao Google em tempo de execução, e não há salto de layout esperando
 * uma folha externa. `display: "swap"` mantém o texto legível enquanto a fonte
 * carrega, com a pilha de fallback declarada abaixo fazendo a ponte.
 *
 * Os pesos são os que o Figma usa (medido: 400, 500, 600, 700). Pedir a família
 * variável inteira seria mais bytes por nada.
 */
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--sb-font-sans",
  fallback: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
});

const dmMono = DM_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
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
      <body>{children}</body>
    </html>
  );
}
