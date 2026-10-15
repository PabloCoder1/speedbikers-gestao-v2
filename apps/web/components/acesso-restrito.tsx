import type { ReactNode } from "react";

import { EstadoDaTela } from "./estado-da-tela";
import { PageTitle } from "./page-title";
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
  /*
    O título da tela continua no cabeçalho (`PageTitle`): quem chegou por um link
    antigo precisa saber ONDE está antes de saber que não pode ficar. A recusa
    vira o estado de permissão (D-502), com o caminho de volta que faltava.
  */
  return (
    <Shell>
      <PageTitle eyebrow="ACESSO RESTRITO" title={titulo} compacto />
      <EstadoDaTela
        tipo="permissao"
        nivel="tela"
        titulo={`Esta tela é restrita a ${papel}.`}
        descricao="Se você precisa dela, peça a quem administra a organização para ajustar o seu papel em Usuários."
        acao={{ href: "/", rotulo: "Ir para o início" }}
      />
    </Shell>
  );
}
