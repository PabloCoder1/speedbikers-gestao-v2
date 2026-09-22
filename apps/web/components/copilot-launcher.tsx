"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import dynamic from "next/dynamic";
import { CarregandoBloco } from "./carregando";
import { useCopilotScreenContext, type CopilotScreenContext } from "./copilot-context";
import { Drawer } from "./drawer";

const CopilotChat = dynamic(() => import("../app/copiloto/chat").then((module) => module.CopilotChat), {
  ssr: false,
  loading: () => <CarregandoBloco rotulo="Copiloto" />,
});

/**
 * A GAVETA DO COPILOTO (D-294) — o último item aberto da frente visual.
 *
 * O frame nunca teve uma TELA de Copiloto: ele desenha uma gaveta de 420px à
 * direita, aberta de qualquer página (D-276). Ela ficou adiada até a
 * pré-condição existir, e a pré-condição foi paga em D-293: a rota recebe
 * contexto de tela, e há ferramenta de estoque e de anúncio.
 *
 * ## O GATILHO: o botão flutuante do canto (D-377)
 *
 * O frame sempre desenhou um botão flutuante, e o `Shell` o recusava com um
 * motivo que era verdadeiro: "seria um TERCEIRO caminho para uma rota que já
 * está no menu e no topbar". O pedido do dono foi tirar o Copiloto da barra e
 * pôr no canto, e a recusa cai junto com a premissa — o flutuante não SOMA a
 * um terceiro caminho, ele substitui os dois. O ✦ saiu da barra de topo, o
 * item saiu do menu lateral, e sobrou um gatilho só.
 *
 * O que isso compra, além do espaço nas duas barras: o botão não rola com a
 * página e não depende da barra de topo caber, então a pergunta fica à mesma
 * distância em toda tela — que é a única coisa que uma conversa sobre "a tela
 * em que estou" pode prometer.
 *
 * Ele fica ABAIXO da camada flutuante (`--sb-z-flutuante`, 15 contra os 20 do
 * `.sb-backdrop`): com a gaveta aberta, o vidro passa por cima dele em vez de
 * deixá-lo boiando sobre o próprio painel que ele abriu.
 *
 * A tela cheia `/copiloto` continua existindo e continua no `Ctrl+K`
 * (`PAGINAS_FORA_DO_MENU`, em `nav.tsx`) — o rodapé da gaveta leva a ela.
 *
 * ## O que ela é, e o que ela continua não sendo
 *
 * - a moldura é a `Drawer` das outras cinco (D-281) — mesma camada, mesmo
 *   `Escape`, mesmo portal;
 * - o chat é o MESMO componente da tela cheia, com `contexto` e `sugestoes`
 *   por props. Duas implementações de conversa divergiriam no primeiro ajuste,
 *   e a gaveta é onde o operador vai perguntar mais;
 * - **"Análise Pronta" continua fora.** O frame traz um parágrafo de
 *   diagnóstico já escrito, sem cálculo atrás. O que existe de análise pronta
 *   nesta casa é a narração do diagnóstico do SKU, que tem botão onde o dado
 *   mora — e é gerada sob demanda, não pré-carregada numa gaveta que talvez
 *   ninguém abra. Um parágrafo fixo aqui seria texto de desenho passando por
 *   resposta (D-023).
 */

/** As sugestões de UM clique, por contexto — e só as que têm ferramenta (D-293). */
function sugestoesDo(contexto: CopilotScreenContext | null): readonly string[] {
  if (contexto === null) {
    return [
      "Como foram as vendas nos últimos 7 dias?",
      "Comparado com o período anterior, vendi mais ou menos?",
      "Qual conta vendeu mais neste mês?",
    ];
  }

  if (contexto.kind === "sku") {
    /*
      As três que `sku_replenishment` responde. "Quanto enviar ao Full?" — que
      o frame sugere — continua fora: não há política logística por trás
      (D-147), e sugestão que o sistema não responde é pior que campo vazio,
      porque promete e falha DEPOIS de gastar uma chamada paga.
    */
    return [
      `Como está o estoque do SKU ${contexto.id}?`,
      `Quanto devo comprar do SKU ${contexto.id}?`,
      `A cobertura do SKU ${contexto.id} está caindo?`,
    ];
  }

  /*
    As duas que `listing_performance` responde. "Ver histórico de exposição"
    fica fora: é o dado de tráfego por dia que D-266 mediu como inexistente no
    esquema — o desenho é coerente consigo mesmo e incoerente com o sistema.
  */
  return [
    `Como está a conversão do anúncio ${contexto.id} nos últimos 30 dias?`,
    `O anúncio ${contexto.id} está recebendo visita?`,
  ];
}

export function CopilotLauncher(): ReactNode {
  const [aberta, setAberta] = useState(false);
  const contexto = useCopilotScreenContext();

  return (
    <>
      {/*
        `aria-label="Copiloto"` e `type="button"` são os MESMOS de quando ele
        morava na barra: o que mudou foi onde ele é desenhado, não o que ele é.
        A suíte de e2e localiza por papel e nome, e continua achando.
      */}
      <button
        type="button"
        className="sb-copilot-fab"
        title="Copiloto"
        aria-label="Copiloto"
        aria-expanded={aberta}
        onClick={() => {
          setAberta(true);
        }}
      >
        <span aria-hidden="true">✦</span>
      </button>

      {aberta && (
        <Drawer
          eyebrow="Copiloto"
          label="Copiloto"
          onClose={() => {
            setAberta(false);
          }}
          footer={
            /*
              A tela cheia continua existindo e é para onde a conversa longa
              vai: a gaveta é o atalho de onde o dado está.
            */
            <Link className="sb-button" href="/copiloto">
              Abrir o Copiloto →
            </Link>
          }
        >
          {/*
            O "Contexto Atual" do frame, com a diferença que D-276 exigia: ele
            só afirma contexto quando existe contexto. Página que não publica
            um aparece como "nenhum", e a gaveta diz o que dá para perguntar
            mesmo assim — em vez de prometer leitura de uma tela que ninguém
            leu.
          */}
          <p className="sb-note" style={{ marginBottom: "var(--sb-space-3)" }}>
            <span>Contexto atual</span>
            <span
              style={{
                display: "block",
                fontFamily: "var(--sb-sans)",
                fontSize: "0.6875rem",
                marginTop: "0.375rem",
              }}
            >
              {contexto === null
                ? "Nenhum — esta tela não publica um SKU nem um anúncio. As perguntas de venda funcionam de qualquer lugar."
                : `${contexto.label} — as perguntas abaixo já vêm com ele preenchido.`}
            </span>
          </p>

          <CopilotChat contexto={contexto} sugestoes={sugestoesDo(contexto)} compacto />
        </Drawer>
      )}
    </>
  );
}
