"use client";

import { useLinkStatus } from "next/link";
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A ATUALIZAÇÃO NO LUGAR — o retorno de toda navegação que fica na mesma tela
 * (D-500).
 *
 * `loading.tsx` só aparece quando um segmento do caminho muda. A pílula de
 * filtro, o "ver lista" da faixa de KPIs, a opção do menu de filtro, a aba do
 * cabeçalho de objeto, a paginação e a busca levam para a MESMA página com
 * outra `?busca`: nenhum segmento muda, nenhum `loading.tsx` entra, e a tela
 * velha ficava parada até a nova chegar, sem sinal de que o clique pegou.
 *
 * Até D-500 a resposta era cobrir a tela com a `CarregandoTela` depois de
 * 350 ms. Isso apagava exatamente o que a pessoa estava olhando — a tabela, os
 * filtros, o botão que ela acabou de apertar — para mostrar um esqueleto
 * genérico de algo que já estava na tela. Atualizar não é carregar: o dado
 * velho continua válido até o novo chegar.
 *
 * O que acontece agora, enquanto a navegação pende:
 *
 * - **na hora:** o controle clicado esmaece (`a:has(> .sb-link-pendente)`), o
 *   cursor vira "em andamento" e o conteúdo para de aceitar clique — um segundo
 *   clique não dispara outra leitura;
 * - **depois de 100 ms:** a barra de progresso da moldura, na base da barra
 *   superior — a mesma do `loading.tsx`;
 * - **depois de 400 ms:** o conteúdo esmaece, sem sumir;
 * - `aria-busy` no `<main>` e um "Atualizando a tela…" para leitor de tela.
 *
 * Tudo some no instante em que a tela nova chega — o pendente é o da própria
 * navegação (`useLinkStatus`, ou a transição do `FormularioFiltro`), sem
 * temporizador nem atraso artificial. A barra nunca enche: o navegador não sabe
 * quanto falta.
 *
 * A barra vai por PORTAL para a barra superior: o `<Link>` pode estar dentro de
 * um menu fechado, de uma tabela com rolagem ou de uma célula com
 * `overflow: hidden`. Sem barra superior (fora da moldura), vai para o topo da
 * janela.
 */
export function AtualizandoTela(): ReactNode {
  useEffect(marcarConteudoOcupado, []);

  // Só existe depois de um clique ou de um envio, no navegador: quem a monta
  // (`useLinkStatus`, a transição do formulário) nunca está pendente no
  // servidor, então o `document` existe sempre que este ramo roda.
  return createPortal(
    <span className="sb-atualizando-barra" role="status">
      <span className="sb-sr-only">Atualizando a tela…</span>
    </span>,
    document.querySelector(".sb-topbar") ?? document.body,
  );
}

/**
 * Para ir DENTRO de um `<Link>` que fica na mesma tela — é onde `useLinkStatus`
 * enxerga o pendente. O marcador `hidden` só serve para o CSS esmaecer o link
 * clicado sem mudar o tamanho dele.
 */
export function CarregandoSeODemorar(): ReactNode {
  const { pending } = useLinkStatus();

  if (!pending) return null;

  return (
    <>
      <span className="sb-link-pendente" hidden />
      <AtualizandoTela />
    </>
  );
}

/**
 * `aria-busy` no conteúdo enquanto houver ao menos uma atualização pendente. É
 * contador, não liga/desliga: duas navegações seguidas se sobrepõem por um
 * instante, e a primeira a terminar não pode declarar a tela pronta.
 */
let pendentes = 0;

function marcarConteudoOcupado(): () => void {
  const conteudo = document.querySelector(".sb-content");

  pendentes += 1;
  conteudo?.setAttribute("aria-busy", "true");

  return () => {
    pendentes -= 1;

    if (pendentes === 0) conteudo?.removeAttribute("aria-busy");
  };
}
