import Link from "next/link";
import type { ReactNode } from "react";

/**
 * A "pílula" de filtro, compartilhada por `/vendas`, `/anuncios`, `/estoque`,
 * `/curva-abc` e `/atendimento` (D-141).
 *
 * Era o MESMO `pillStyle` copiado em cinco arquivos — cinco lugares para
 * divergir em cor, raio de borda ou contraste, sem que nada quebre quando
 * divergissem. Continua Server Component: é um `Link` estilizado, sem estado.
 *
 * `aria-current` acompanha o estado ativo. Sem ele, a única pista de qual
 * filtro está aplicado é a cor — invisível para leitor de tela e para quem não
 * distingue os dois tons.
 */
/**
 * `tone` existe por um caso real, não por antecipação: em `/atendimento` o
 * filtro "⏱ Prazo em risco" fica VERMELHO quando ativo, porque ali "ligado"
 * significa risco, não seleção. Era a única das dezoito pílulas que divergia,
 * e apagar essa diferença na extração teria trocado um alerta por um filtro
 * comum.
 */
export function FilterPill({
  href,
  active,
  tone = "primary",
  children,
}: {
  href: string;
  active: boolean;
  tone?: "primary" | "danger";
  children: ReactNode;
}): ReactNode {
  /*
    A5: as classes do design system, no lugar do estilo inline.

    A pílula era o ÚLTIMO controle da casa fora do sistema — 13px e raio 8px
    contra os 11px, 32px e raio 6px de `.sb-button`. Por isso `/precos` e
    `/full` mostravam DUAS gramáticas de filtro na mesma tela: o `FilterMenu`
    (que é `.sb-button`) no cabeçalho do painel e a pílula logo abaixo. A
    auditoria A4 fotografou as duas e contou 11 telas com ela.

    O ativo vira `.sb-button-primary` — que é o que o frame faz no painel de
    filtros da Central de Ações (`bg-brand-dark text-white`) — e o tom de
    perigo continua sendo caso próprio, agora como `.sb-button-danger`.
  */
  const variante = active ? (tone === "danger" ? " sb-button-danger" : " sb-button-primary") : "";

  return (
    <Link href={href} aria-current={active ? "true" : undefined} className={`sb-button${variante}`}>
      {children}
    </Link>
  );
}

/**
 * O gêmeo em `<button>` do `FilterPill`, para o submit nativo dos formulários
 * de busca — que precisa continuar sendo botão, não link.
 *
 * **Era uma constante de estilo (`FILTER_SUBMIT_STYLE`) e virou componente com
 * classe**: o "mesmo desenho" que ela existia para garantir agora é literalmente
 * a mesma regra CSS da pílula, não uma cópia para manter em sincronia.
 */
export function FilterSubmit({ children = "Filtrar" }: { children?: ReactNode }): ReactNode {
  return (
    <button type="submit" className="sb-button">
      {children}
    </button>
  );
}

/**
 * O rótulo de um grupo de filtros ("Conta", "Marca", "Critério"). Largura
 * mínima igual em todas as telas para os grupos alinharem verticalmente —
 * era o tipo de detalhe que divergia entre as cinco cópias.
 */
export function FilterGroup({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sb-space-2)", alignItems: "center" }}>
      <span style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)", minWidth: "5rem" }}>{label}</span>
      {children}
    </div>
  );
}
