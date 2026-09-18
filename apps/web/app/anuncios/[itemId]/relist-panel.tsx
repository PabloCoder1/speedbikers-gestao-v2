"use client";

import type { RelistVariationsSummary } from "@sb/domain";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { TOM, tomDeRelist } from "../../../components/tone";
import { useDialogo } from "../../../components/use-dialogo";
import { relistStatusLabel } from "../../../lib/labels";
import { createClient } from "../../../lib/supabase/browser";
import {
  INTERVALO_MS,
  MENSAGEM_NAO_PERMITIDA,
  MENSAGEM_SEM_REPUBLICACAO,
  MENSAGEM_SEM_RESPOSTA,
  atosDaRepublicacao,
  cienciaDaExecucao,
  cienciaDaRetomada,
  descreverVariacaoFora,
  passoDaReleitura,
} from "./republicacao";

/**
 * A SUPERFÍCIE DE CONFIRMAÇÃO HUMANA da republicação (D-295) — o item que
 * D-164 deixou declarado: *"o que NÃO existe: UI"*.
 *
 * O motor inteiro existe desde a Fase 9 (D-159→D-164): modelo com nove
 * estados, preflight fail-safe, pedido, executor re-entrante, remapeamento e
 * medição 7/15/30. O que faltava era o lugar onde uma PESSOA autoriza — e a
 * tela dizia isso por escrito ("republicar é ato humano deliberado, fora da
 * interface"), que era honesto e provisório.
 *
 * ## Dois atos, duas confirmações — e a segunda é a que fecha o anúncio
 *
 * O backend separa pedido e execução de propósito (D-161/D-162), e a
 * interface não podia colapsar os dois num clique só:
 *
 *  1. **Pedir** enfileira a captura do snapshot e o preflight. Nada
 *     destrutivo acontece — e a confirmação DIZ isso, para o operador não
 *     hesitar no ato inofensivo e nem relaxar no perigoso;
 *  2. **Executar** fecha o anúncio pai no Mercado Livre. Isso é
 *     **irreversível** (secao 2.16), e a confirmação exige um gesto a mais:
 *     marcar que se entende o que vai acontecer. Não é atrito decorativo —
 *     é a diferença entre um clique errado e um anúncio fechado.
 *
 * ## Depois do envio, o botão não volta (D-360)
 *
 * O worker leva segundos para mudar o estado, e o `router.refresh()` logo
 * depois do envio ainda lê a operação como estava. Em 2026-09-16 isso deixou
 * "Executar republicação" na tela, e um segundo clique, 11 s depois de a
 * republicação já ter terminado, voltou como "A API recusou o pedido (HTTP
 * 409)". Agora o botão some até a operação mudar, a tela relê sozinha por
 * alguns segundos, e um 409 é tratado como o que ele é: o estado andou.
 *
 * ## Falhou ao republicar: recusa ou "exige gente" (D-364)
 *
 * RELIST_FAILED é o anúncio antigo fechado sem anúncio novo confirmado. Quando
 * a última falha foi RECUSA do Mercado Livre (o MLB1476804187, com variações,
 * levou 400 em 2026-09-16), nenhum anúncio novo nasceu: a tela explica isso e
 * oferece **Tentar republicar de novo**, que chama a retomada da `api` e entra
 * no mesmo acompanhamento da execução. Qualquer outra falha pode ter criado o
 * anúncio novo — a tela diz que alguém precisa conferir, e não oferece botão.
 * A regra é a do domínio (`isRelistRetryEligible`), calculada pela página.
 *
 * ## Variações em conta de user products: não há republicação (D-369)
 *
 * Em 2026-09-17 o Mercado Livre recusou a retomada do MLB1476804187 com
 * `item.variations.relist.invalid`: não aceita relist de item com variações
 * de vendedor no modelo de user products. Recusa com essa causa não oferece
 * botão — a tela diz que o ML não permite e que o anúncio antigo segue
 * fechado. Quando a conferência reprova por esse motivo sem fechar nada
 * (PREFLIGHT_FAILED, ou CLOSE_FAILED na retomada de CLOSING) e o retrato tem
 * variações, "Pedir republicação" some: outro pedido reprovaria igual. O
 * painel mostra só um aviso: a descrição do bloqueio já é o motivo da falha
 * na tabela, e repeti-la aqui seria o mesmo dado em dois lugares. A execução
 * nunca é oferecida (só REQUESTED é executável).
 *
 * As duas confirmações listam as variações que ficam FORA do anúncio novo
 * (sem estoque no retrato do pedido, `summarizeRelistVariations`), e com
 * variação de fora a caixa de ciência diz isso: o dono não confirma sem saber
 * que o anúncio novo nasce menor. Se o worker terminar sem mudar a operação,
 * a tela para de esperar depois das releituras e diz o que conferir.
 *
 * ## O que a interface NÃO decide
 *
 * Nada. Papel (ADMIN/GESTOR) e escopo por conta são impostos no servidor
 * (D-161), e o worker **re-roda o preflight na hora da execução** de qualquer
 * forma: o estado do anúncio muda entre o pedido e o ato. Esconder o botão de
 * quem não pode é cortesia, não segurança — e a cortesia importa porque
 * oferecer o que o servidor vai negar é pior do que não oferecer.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

export interface RelistOperation {
  id: string;
  status: string;
  failureReason: string | null;
  childItemId: string | null;
  createdAt: string;
  /** Muda a cada transição — é o que prova que o worker respondeu. */
  updatedAt: string;
  /** RELIST_FAILED por recusa comprovada do Mercado Livre (D-364). */
  retomavel: boolean;
}

type Estado =
  | { kind: "idle" }
  | { kind: "confirmando-pedido" }
  | { kind: "confirmando-execucao" }
  | { kind: "confirmando-retomada" }
  | { kind: "enviando" }
  | { kind: "enfileirado"; mensagem: string; operacaoNoEnvio: string | null }
  | { kind: "estado-mudou"; mensagem: string }
  | { kind: "sem-resposta"; mensagem: string }
  | { kind: "erro"; mensagem: string };

export function RelistPanel({
  itemId,
  mlAccountId,
  podeRepublicar,
  variacoes,
  operacao,
}: {
  itemId: string;
  mlAccountId: string;
  /** ADMIN ou GESTOR — o mesmo par que a rota exige (D-161). */
  podeRepublicar: boolean;
  /** As variações do retrato do pedido e as que ficam fora do anúncio novo (D-364); o total também decide o pedido (D-369). */
  variacoes: RelistVariationsSummary;
  /** A operação viva deste anúncio como PAI, se houver. */
  operacao: RelistOperation | null;
}): ReactNode {
  const router = useRouter();
  const [estado, setEstado] = useState<Estado>({ kind: "idle" });

  // A operação como a tela a vê AGORA. Enquanto ela for a mesma do momento do
  // envio, o worker ainda não respondeu: nenhum botão de ato é oferecido. O
  // `updatedAt` entra porque a retomada pode voltar ao MESMO estado
  // (RELIST_FAILED recusado de novo) — só o status não veria a mudança.
  const operacaoAtual = operacao === null ? null : `${operacao.id}:${operacao.status}:${operacao.updatedAt}`;
  const aguardandoWorker =
    estado.kind === "enviando" || (estado.kind === "enfileirado" && estado.operacaoNoEnvio === operacaoAtual);
  const atos = atosDaRepublicacao({ podeRepublicar, operacao, variacoesDoRetrato: variacoes.total, aguardandoWorker });

  useEffect(() => {
    if (!aguardandoWorker || estado.kind !== "enfileirado") {
      return;
    }

    let leituras = 0;
    const timer = setInterval(() => {
      leituras += 1;

      // Passadas as releituras sem mudança, a tela SAI da espera (D-364): o
      // worker pode ter terminado sem transição, e "enfileirado" para sempre
      // não explicaria nada — nem devolveria os botões.
      if (passoDaReleitura(leituras) === "desistir") {
        clearInterval(timer);
        setEstado({ kind: "sem-resposta", mensagem: MENSAGEM_SEM_RESPOSTA });

        return;
      }

      router.refresh();
    }, INTERVALO_MS);

    return () => {
      clearInterval(timer);
    };
  }, [aguardandoWorker, estado.kind, router]);

  async function chamar(caminho: string, corpo: unknown, mensagem: string): Promise<void> {
    const operacaoNoEnvio = operacaoAtual;
    setEstado({ kind: "enviando" });

    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

    if (token === undefined) {
      setEstado({ kind: "erro", mensagem: "Sessão expirada — atualize a página e entre de novo." });

      return;
    }

    try {
      const response = await fetch(`${API_URL}${caminho}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(corpo),
      });

      if (!response.ok) {
        /*
          O SERVIDOR É QUEM SABE, e o texto dele chega inteiro: 403 de papel,
          409 de estado ("já existe operação viva"), 404 de anúncio de outra
          conta. Traduzir isso aqui em "não foi possível" apagaria justamente
          a informação que faz a pessoa entender o que fazer em seguida.
        */
        const corpoErro = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        const motivo = corpoErro?.error?.message ?? `A API recusou o pedido (HTTP ${String(response.status)}).`;

        // 409 é o estado que andou desde que a tela foi desenhada — quase
        // sempre por um envio anterior que já foi atendido. Não é falha:
        // a tela relê e mostra onde a operação está.
        if (response.status === 409) {
          setEstado({ kind: "estado-mudou", mensagem: `A operação já mudou de estado (${motivo}). A tela foi atualizada.` });
          router.refresh();

          return;
        }

        setEstado({ kind: "erro", mensagem: motivo });

        return;
      }

      setEstado({ kind: "enfileirado", mensagem, operacaoNoEnvio });
      // O estado real vive no banco e muda pelo worker: a tela relê em vez de
      // fingir que já sabe o desfecho.
      router.refresh();
    } catch {
      setEstado({ kind: "erro", mensagem: "Falha de conexão com a API." });
    }
  }

  return (
    <div style={{ display: "grid", gap: "var(--sb-space-2)" }}>
      {/*
        SÓ O ESTADO. Motivo da falha e anúncio filho já são colunas da tabela
        logo abaixo — repeti-los aqui seria o mesmo dado em dois lugares na
        mesma tela, e o primeiro a divergir seria este. O estado fica porque é
        dele que dependem os botões.
      */}
      {operacao !== null && (
        <p style={{ margin: 0, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "0.5rem", fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>
          Operação atual
          <span className="sb-status" style={TOM[tomDeRelist(operacao.status)]}>
            {relistStatusLabel(operacao.status)}
          </span>
        </p>
      )}

      {!podeRepublicar && (
        <p style={{ margin: 0, fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>
          Republicar é decisão de gestão: só ADMIN e GESTOR podem pedir. Quem atende não encerra anúncio.
        </p>
      )}

      {atos.falha === "recusada" && (
        <p style={{ margin: 0, fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>
          O Mercado Livre <b>recusou</b> a republicação: nenhum anúncio novo foi criado, e o anúncio antigo continua
          fechado. O motivo está na tabela abaixo.
        </p>
      )}

      {atos.falha === "nao-permitida" && (
        <p style={{ margin: 0, fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>{MENSAGEM_NAO_PERMITIDA}</p>
      )}

      {atos.semRepublicacao && (
        <p style={{ margin: 0, fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>{MENSAGEM_SEM_REPUBLICACAO}</p>
      )}

      {atos.falha === "exige-gente" && (
        <p style={{ margin: 0, fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>
          O anúncio antigo está fechado e o novo não foi confirmado. Daqui não dá para saber se ele nasceu — tentar de
          novo poderia criar dois anúncios. <b>Alguém precisa conferir no Mercado Livre.</b>
        </p>
      )}

      {atos.retomar && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            className="sb-button sb-button-primary"
            onClick={() => {
              setEstado({ kind: "confirmando-retomada" });
            }}
          >
            Tentar republicar de novo
          </button>
        </div>
      )}

      {atos.pedir && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            className="sb-button"
            onClick={() => {
              setEstado({ kind: "confirmando-pedido" });
            }}
          >
            Pedir republicação
          </button>
        </div>
      )}

      {atos.executar && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            className="sb-button sb-button-danger"
            onClick={() => {
              setEstado({ kind: "confirmando-execucao" });
            }}
          >
            Executar republicação
          </button>
        </div>
      )}

      {estado.kind === "enfileirado" && aguardandoWorker && (
        <p role="status" style={{ margin: 0, fontSize: "0.75rem", color: "var(--sb-secondary)" }}>
          {estado.mensagem}
        </p>
      )}

      {estado.kind === "sem-resposta" && (
        <p role="status" style={{ margin: 0, fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>
          {estado.mensagem}
        </p>
      )}

      {estado.kind === "estado-mudou" && (
        <p role="status" style={{ margin: 0, fontSize: "0.75rem", color: "var(--sb-secondary)" }}>
          {estado.mensagem}
        </p>
      )}

      {estado.kind === "erro" && (
        <p role="alert" style={{ margin: 0, fontSize: "0.75rem", color: "var(--sb-danger)" }}>
          {estado.mensagem}
        </p>
      )}

      {estado.kind === "confirmando-pedido" && (
        <Confirmacao
          eyebrow="Pedir republicação"
          titulo={`Pedir republicação de ${itemId}`}
          confirmar="Pedir republicação"
          onCancel={() => {
            setEstado({ kind: "idle" });
          }}
          onConfirm={() => {
            void chamar(
              "/v1/listings/relist",
              { mlAccountId, itemId },
              "Pedido enfileirado. A conferência roda no worker e o estado aparece aqui quando terminar.",
            );
          }}
        >
          <p style={{ margin: 0 }}>
            Este ato <b>não fecha nada</b>. Ele guarda o retrato do anúncio e roda a conferência prévia — a que
            recusa republicar anúncio já republicado, com estoque no Full, de catálogo, que já é filho de outra
            republicação ou com variações em conta de user products.
          </p>
          <p style={{ margin: 0 }}>
            Se a conferência aprovar, a operação fica <b>aguardando execução</b> — e é a execução, num segundo
            passo, que fecha este anúncio.
          </p>
        </Confirmacao>
      )}

      {estado.kind === "confirmando-execucao" && operacao !== null && (
        <Confirmacao
          eyebrow="Executar republicação"
          titulo={`Fechar ${itemId} e republicar`}
          confirmar="Fechar e republicar"
          perigoso
          exigirCiencia={cienciaDaExecucao(variacoes.leftOut.length)}
          onCancel={() => {
            setEstado({ kind: "idle" });
          }}
          onConfirm={() => {
            void chamar(
              `/v1/listings/relist/${operacao.id}/execute`,
              {},
              "Execução enfileirada. O worker refaz a conferência, fecha o anúncio e republica.",
            );
          }}
        >
          {/*
            A CONSEQUÊNCIA, escrita — a mesma régua da curadoria em lote
            (D-127): confirmação que só conta quantos não é confirmação.
          */}
          <p style={{ margin: 0 }}>
            O anúncio <span className="sb-mono">{itemId}</span> será <b>fechado no Mercado Livre</b>, e fechar é{" "}
            <b>irreversível</b>: ele não volta a ficar ativo.
          </p>
          <p style={{ margin: 0 }}>
            No lugar dele nasce um anúncio <b>novo, com outro MLB</b>. Anúncio grátis não herda visitas nem vendas,
            e a exposição não é prometida por ninguém — nem pelo Mercado Livre, nem por esta tela.
          </p>
          <VariacoesDoAnuncioNovo variacoes={variacoes} />
          <p style={{ margin: 0 }}>
            A conferência prévia roda <b>de novo agora</b>, com o estado atual do anúncio: se algo mudou desde o
            pedido, a operação para antes de fechar.
          </p>
        </Confirmacao>
      )}

      {estado.kind === "confirmando-retomada" && operacao !== null && (
        <Confirmacao
          eyebrow="Tentar republicar de novo"
          titulo={`Republicar ${itemId} de novo`}
          confirmar="Tentar republicar de novo"
          exigirCiencia={cienciaDaRetomada(variacoes.leftOut.length)}
          onCancel={() => {
            setEstado({ kind: "idle" });
          }}
          onConfirm={() => {
            void chamar(
              `/v1/listings/relist/${operacao.id}/retry`,
              {},
              "Nova tentativa enfileirada. O worker confere o anúncio fechado e envia a republicação de novo.",
            );
          }}
        >
          <p style={{ margin: 0 }}>
            O Mercado Livre recusou a tentativa anterior, e <b>nenhum anúncio novo nasceu dela</b>. O anúncio{" "}
            <span className="sb-mono">{itemId}</span> continua fechado.
          </p>
          <p style={{ margin: 0 }}>
            O worker confere o anúncio <b>de novo agora</b> — ele precisa estar fechado e ter estoque — e envia a
            republicação só com as variações que têm estoque, cada uma com o próprio preço.
          </p>
          <VariacoesDoAnuncioNovo variacoes={variacoes} />
          <p style={{ margin: 0 }}>
            Se o Mercado Livre recusar de novo, o motivo aparece na tabela abaixo. Nada é repetido sozinho.
          </p>
        </Confirmacao>
      )}
    </div>
  );
}

/**
 * As variações que o anúncio novo NÃO leva (D-364), escritas na confirmação —
 * a mesma régua de D-127: confirmar sem ver o que se perde não é confirmar. A
 * lista é a do retrato do pedido; o worker refaz a conta com o estoque da hora.
 */
function VariacoesDoAnuncioNovo({ variacoes }: { variacoes: RelistVariationsSummary }): ReactNode {
  if (variacoes.total === 0) {
    return null;
  }

  return (
    <>
      <p style={{ margin: 0 }}>
        O anúncio tem {variacoes.total} variações, e o anúncio novo leva <b>só as que tiverem estoque</b> na hora do
        envio.{" "}
        {variacoes.leftOut.length === 0
          ? "No retrato do pedido, todas tinham."
          : `No retrato do pedido, ${String(variacoes.leftOut.length)} estavam sem estoque e ficam fora — não voltam no anúncio novo:`}
      </p>
      {variacoes.leftOut.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
          {variacoes.leftOut.map((variacao) => (
            <li key={variacao.id} className="sb-mono">
              {descreverVariacaoFora(variacao)}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * A caixa de confirmação — `.sb-modal` da casa, como a curadoria em lote e os
 * Filtros Salvos. `exigirCiencia` acrescenta a caixa de seleção que destrava o
 * botão: ela existe só no ato irreversível.
 */
function Confirmacao({
  eyebrow,
  titulo,
  confirmar,
  perigoso = false,
  exigirCiencia,
  onCancel,
  onConfirm,
  children,
}: {
  eyebrow: string;
  titulo: string;
  confirmar: string;
  perigoso?: boolean;
  exigirCiencia?: string | undefined;
  onCancel: () => void;
  onConfirm: () => void;
  children: ReactNode;
}): ReactNode {
  const [ciente, setCiente] = useState(false);
  const travado = exigirCiencia !== undefined && !ciente;
  // Esc, foco no Cancelar e rolagem travada (lote 3 do pente fino): este é o
  // diálogo que FECHA o anúncio — Enter por reflexo não pode confirmar.
  const dialogo = useDialogo<HTMLDivElement>(true, onCancel);

  return (
    <div className="sb-backdrop" onClick={onCancel}>
      <div
        ref={dialogo}
        role="dialog"
        aria-modal="true"
        aria-label={titulo}
        className="sb-modal"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <span className="sb-modal-eyebrow">{eyebrow}</span>
        <h2 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1rem" }}>{titulo}</h2>

        <div style={{ display: "grid", gap: "var(--sb-space-2)", fontSize: "0.8125rem" }}>{children}</div>

        {exigirCiencia !== undefined && (
          <label style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", marginTop: "var(--sb-space-3)", fontSize: "0.8125rem" }}>
            <input
              type="checkbox"
              checked={ciente}
              onChange={(event) => {
                setCiente(event.target.checked);
              }}
            />
            <span>{exigirCiencia}</span>
          </label>
        )}

        <div style={{ display: "flex", gap: "var(--sb-space-2)", marginTop: "var(--sb-space-3)", justifyContent: "flex-end" }}>
          <button type="button" className="sb-button" onClick={onCancel} data-foco-inicial>
            Cancelar
          </button>
          <button
            type="button"
            className={perigoso ? "sb-button sb-button-danger" : "sb-button sb-button-primary"}
            disabled={travado}
            onClick={onConfirm}
          >
            {confirmar}
          </button>
        </div>
      </div>
    </div>
  );
}
