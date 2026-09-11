import type { ReactNode } from "react";

import { Shell } from "./shell";

/**
 * A recusa de tela inteira por PAPEL.
 *
 * Nasceu inline em `/saude` (D-176) e ganhou casa própria quando as três telas
 * de `/importacoes` passaram a precisar da mesma resposta (D-312) — a quarta
 * cópia seria a que sairia de sincronia, que é o que D-246 mediu cinco vezes
 * com mapas de tom.
 *
 * **A regra que ela NÃO substitui.** Esconder o menu e recusar a página são
 * cortesia; a defesa é o servidor — as policies de RLS e o papel exigido pela
 * api. Uma tela que só esconde o botão continua devolvendo o dado a quem sabe o
 * endereço (D-295 §3). Por isso a recusa aqui é acompanhada de gate real em
 * cada leitura, e não substitui nenhum.
 *
 * Diz o que falta e não pede desculpa: quem chega aqui normalmente clicou num
 * link antigo ou herdou um endereço de outra pessoa, e a informação útil é o
 * papel exigido.
 */
export function AcessoRestrito({ titulo, papel = "ADMIN" }: { titulo: string; papel?: string }): ReactNode {
  return (
    <Shell>
      <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>{titulo}</h1>
      <p style={{ color: "var(--sb-text-soft)" }}>Esta tela é restrita a {papel}.</p>
    </Shell>
  );
}
