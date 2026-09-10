"use client";

import { useRef, useState, type ReactNode } from "react";

import type { CopilotScreenContext } from "../../components/copilot-context";
import { createClient } from "../../lib/supabase/browser";

/**
 * Chat do Copiloto (D-114). O texto chega por SSE delta a delta — inclusive
 * o preâmbulo antes de uma consulta — e as consultas aparecem como marcador
 * ("consultou vendas do período…") para o escopo ficar visível, como os
 * requisitos pedem.
 *
 * Sem histórico persistido nesta fatia: cada pergunta é independente
 * (`/v1/copilot/chat` recebe UMA mensagem). Conversa multi-turno com
 * memória é evolução separada — o transporte já a comporta.
 */

/**
 * As sugestões do frame, refeitas: **uma por ferramenta que existe** (D-276).
 *
 * O drawer do Figma oferece doze perguntas prontas, e o Copiloto tem TRÊS
 * ferramentas, todas de venda. Onze das doze não têm como ser respondidas —
 * uma delas pede "histórico de exposição", que é justamente o dado de tráfego
 * que D-266 mediu como inexistente no esquema.
 *
 * Sugestão que o sistema não responde é pior que campo vazio: o campo vazio
 * não promete nada, e a sugestão promete e falha depois de gastar uma chamada
 * paga. Estas três são a lista de ferramentas escrita em português.
 */
const SUGESTOES = [
  "Como foram as vendas nos últimos 7 dias?",
  "Comparado com o período anterior, vendi mais ou menos?",
  "Qual conta vendeu mais neste mês?",
] as const;

/*
  AS FERRAMENTAS DE D-293 NÃO GANHARAM SUGESTÃO AQUI, e a ausência é a decisão.

  "Como está o estoque do SKU …?" precisa de um código, e esta tela não sabe
  qual — uma sugestão com lacuna para o operador preencher é pior do que
  nenhuma: ela promete um clique e entrega uma tarefa. As duas são alcançáveis
  digitando, e onde elas viram sugestão de UM clique é na gaveta, que sabe o
  SKU ou o anúncio aberto.
*/

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

const TOOL_LABEL: Record<string, string> = {
  sales_summary: "consultou vendas do período",
  sales_period_comparison: "comparou com o período anterior",
  sales_account_comparison: "comparou as contas",
  // As duas de D-293. O marcador existe para o ESCOPO ficar visível: sem ele,
  // uma resposta sobre estoque e uma sobre venda chegam iguais na tela.
  sku_replenishment: "consultou estoque e reposição do SKU",
  listing_performance: "consultou desempenho do anúncio",
};

interface Exchange {
  question: string;
  answer: string;
  tools: string[];
  status: "streaming" | "done" | "error";
}

type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string }
  | { type: "done"; toolsUsed: string[] }
  | { type: "error"; message: string };

export function CopilotChat({
  contexto = null,
  sugestoes = SUGESTOES,
  compacto = false,
}: {
  /**
   * O contexto de tela (D-294). Vai no corpo do pedido e aparece como selo —
   * a gaveta o tem; a tela cheia, não.
   */
  contexto?: CopilotScreenContext | null;
  /** As sugestões deste lugar: as três de venda aqui, as do contexto na gaveta. */
  sugestoes?: readonly string[];
  /** Dentro da gaveta a medida é a dela, não os 46rem de leitura da página. */
  compacto?: boolean;
} = {}): ReactNode {
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  function patchLast(patch: (exchange: Exchange) => Exchange): void {
    setExchanges((current) => {
      const next = [...current];
      const last = next[next.length - 1];

      if (last !== undefined) {
        next[next.length - 1] = patch(last);
      }

      return next;
    });
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }

  /*
    A pergunta vem por PARÂMETRO quando parte de uma sugestão: `setDraft` é
    assíncrono, e ler `draft` logo depois de escrevê-lo mandaria a pergunta
    anterior — ou vazia, na primeira vez.
  */
  async function ask(pergunta?: string): Promise<void> {
    const question = (pergunta ?? draft).trim();

    if (question.length === 0 || busy) {
      return;
    }

    setBusy(true);
    setDraft("");
    setExchanges((current) => [...current, { question, answer: "", tools: [], status: "streaming" }]);

    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

    if (token === undefined) {
      patchLast((exchange) => ({ ...exchange, answer: "Sessão expirada — atualize a página.", status: "error" }));
      setBusy(false);

      return;
    }

    try {
      const response = await fetch(`${API_URL}/v1/copilot/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        /*
          O CONTEXTO VIAJA COM A PERGUNTA (D-294). Só o par que a ferramenta
          usa — `kind`, `id` e a conta quando é anúncio; o rótulo é da tela e
          não interessa à API.
        */
        body: JSON.stringify({
          message: question,
          ...(contexto === null
            ? {}
            : {
                context: {
                  kind: contexto.kind,
                  id: contexto.id,
                  ...(contexto.mlAccountId === undefined ? {} : { mlAccountId: contexto.mlAccountId }),
                },
              }),
        }),
      });

      if (!response.ok || response.body === null) {
        patchLast((exchange) => ({ ...exchange, answer: "Não foi possível consultar o Copiloto.", status: "error" }));

        return;
      }

      // Parse de SSE sobre fetch: eventos separados por linha em branco,
      // payload em linhas `data:`.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        const chunks = buffer.split("\n\n");

        buffer = chunks.pop() ?? "";

        for (const chunk of chunks) {
          const dataLine = chunk
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("");

          if (dataLine.length === 0) {
            continue;
          }

          let event: ChatEvent;

          try {
            event = JSON.parse(dataLine) as ChatEvent;
          } catch {
            continue;
          }

          if (event.type === "text") {
            const delta = event.delta;

            patchLast((exchange) => ({ ...exchange, answer: exchange.answer + delta }));
          } else if (event.type === "tool") {
            const name = event.name;

            patchLast((exchange) => ({ ...exchange, tools: [...exchange.tools, name] }));
          } else if (event.type === "done") {
            patchLast((exchange) => ({ ...exchange, status: "done" }));
          } else {
            const message = event.message;

            patchLast((exchange) => ({
              ...exchange,
              answer: exchange.answer.length > 0 ? exchange.answer : message,
              status: "error",
            }));
          }
        }
      }

      // Conexão encerrada sem evento `done`: não fingir que terminou bem.
      patchLast((exchange) =>
        exchange.status === "streaming" ? { ...exchange, status: "error" } : exchange,
      );
    } catch {
      patchLast((exchange) => ({
        ...exchange,
        answer: exchange.answer.length > 0 ? exchange.answer : "Falha de conexão.",
        status: "error",
      }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: "var(--sb-space-3)", ...(compacto ? {} : { maxWidth: "46rem" }) }}>
      <div
        ref={listRef}
        style={{
          display: exchanges.length === 0 ? "none" : "grid",
          gap: "var(--sb-space-3)",
          maxHeight: "60vh",
          overflowY: "auto",
        }}
      >
        {exchanges.map((exchange, index) => (
          <div key={index} style={{ display: "grid", gap: "var(--sb-space-1)" }}>
            <p
              style={{
                margin: 0,
                justifySelf: "end",
                background: "var(--sb-primary)",
                color: "var(--sb-white)",
                borderRadius: "var(--sb-radius)",
                padding: "0.5rem 0.75rem",
                fontSize: "0.9375rem",
                maxWidth: "80%",
              }}
            >
              {exchange.question}
            </p>

            {exchange.tools.length > 0 && (
              <p style={{ margin: 0, fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>
                {exchange.tools.map((tool) => TOOL_LABEL[tool] ?? tool).join(" · ")}
              </p>
            )}

            <div
              style={{
                background: "var(--sb-surface)",
                border: "1px solid var(--sb-border)",
                borderRadius: "var(--sb-radius)",
                padding: "0.625rem 0.75rem",
                fontSize: "0.9375rem",
                whiteSpace: "pre-wrap",
                maxWidth: "90%",
                color: exchange.status === "error" ? "var(--sb-danger)" : "inherit",
              }}
            >
              {exchange.answer.length > 0 ? exchange.answer : exchange.status === "streaming" ? "…" : ""}
            </div>
          </div>
        ))}
      </div>

      {/*
        As sugestões só aparecem no ESTADO VAZIO. Depois da primeira pergunta
        elas viram ruído: quem já perguntou uma vez sabe o que pode perguntar,
        e o que importa na tela passa a ser a resposta.
      */}
      {exchanges.length === 0 && (
        /*
          A LISTA DE ESCOLHAS USA A LARGURA; A CONVERSA NÃO (P3 de A4, D-287).

          O bloco inteiro nasceu para a gaveta de 430px do frame e ficou preso a
          uma coluna estreita numa página de ~1.150px — três botões empilhados
          com um terço da tela vazio ao lado. Sugestão é ESCOLHA, e escolha se lê
          em paralelo: vira grade que se acomoda à largura.

          **A conversa continua com a medida de 46rem**, e isso não é descuido: o
          limite existe para a LEITURA. Linha de prosa que atravessa 1.150px é
          pior de ler, não melhor — a largura ociosa ali é o preço de uma medida
          legível, e o preço está certo.
        */
        <div style={{ display: "grid", gap: "0.5rem" }}>
          <span
            style={{
              fontFamily: "var(--sb-mono)",
              fontSize: "0.5625rem",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: "var(--sb-text-soft)",
            }}
          >
            O que dá para perguntar
          </span>

          <div
            style={{
              display: "grid",
              gap: "0.5rem",
              /*
                13rem e não 16rem: dentro da medida de leitura de 46rem, é o
                maior mínimo em que as TRÊS sugestões cabem numa linha só —
                com 16rem sobrava uma órfã embaixo, que é o defeito que este
                acabamento existe para tirar, só que na horizontal.
              */
              gridTemplateColumns: compacto ? "1fr" : "repeat(auto-fit, minmax(13rem, 1fr))",
            }}
          >
            {sugestoes.map((sugestao) => (
              <button
                className="sb-button"
                key={sugestao}
                type="button"
                disabled={busy}
                onClick={() => {
                  void ask(sugestao);
                }}
                /*
                  `.sb-button` é `nowrap` — certo para rótulo, errado para
                  FRASE: na grade a do meio saía cortada ("…vendi ma"). Aqui o
                  conteúdo é uma pergunta inteira, e ela quebra.
                */
                style={{
                  textAlign: "left",
                  color: "var(--sb-text)",
                  whiteSpace: "normal",
                  height: "auto",
                  minHeight: "2rem",
                  paddingBlock: "0.375rem",
                  lineHeight: 1.35,
                }}
              >
                {sugestao}
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: "var(--sb-space-2)" }}>
        <input
          className="sb-input"
          aria-label="Pergunta ao Copiloto"
          value={draft}
          placeholder="Ex.: como foram as vendas nos últimos 7 dias?"
          maxLength={1000}
          disabled={busy}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              void ask();
            }
          }} style={{ flex: 1 }}
        />
        <button
          className="sb-button sb-button-primary"
          type="button"
          disabled={busy || draft.trim().length === 0}
          onClick={() => {
            void ask();
          }}
        >
          {busy ? "Consultando…" : "Perguntar"}
        </button>
      </div>
    </div>
  );
}
