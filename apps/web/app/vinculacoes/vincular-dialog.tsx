"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { formatCount, formatCurrency, formatDateTime } from "../../lib/format";
import { createClient } from "../../lib/supabase/browser";
import { iniciaisDaConta, TONS_DE_CONTA } from "../../lib/vinculacoes-visao";
import {
  lerSugestoesDoAnuncio,
  planejarVinculo,
  type AlvoSugerido,
  type OpcaoSku,
  type PlanoDeVinculo,
} from "../../lib/vinculo-sugestao";

import { createManualLink, dismissLinkCandidate, resolveLinkCandidate } from "./actions";
import { BuscaSku } from "./busca-sku";

/**
 * O POPUP DE VINCULAR (D-374).
 *
 * O dono: "sempre que clicamos para vincular algo a tela leva-nos lá para
 * baixo". O "Vincular" de cada linha era um link para a própria página com
 * `#vincular-a-mao`: refazia as oito leituras e rolava até o formulário no fim.
 * Agora o vínculo acontece aqui, sobre a tabela, sem navegar.
 *
 * O que ele faz para o vínculo ser RÁPIDO e CERTO:
 * - abre com a sugestão do SKU vinda dos pedidos do anúncio
 *   (`get_listing_link_suggestions`): o `seller_sku` que o vendedor digitou no
 *   ML, casado com o catálogo. Só pré-seleciona quando é inequívoco;
 * - anúncio com variação nos pedidos vira um alvo por variação, na ordem do que
 *   mais vende, e o popup fica aberto até a última;
 * - não oferece o que a RPC recusaria (mistura de formas, D-125);
 * - avisa quando o anúncio é do Full: até a D-352, o vínculo de anúncio Full
 *   baixa o estoque da LOJA por engano;
 * - "Vincular e próximo" leva direto ao próximo sem vínculo da página.
 *
 * Três modos: um anúncio da tabela, um candidato do ERP (que tem o SKU
 * informado, e fecha o candidato na mesma transação) e o MLB digitado à mão.
 */

export interface AnuncioAlvo {
  readonly mlAccountId: string;
  readonly accountLabel: string;
  readonly itemId: string;
  readonly title: string | null;
  readonly price: number | null;
  readonly unitsSold: number | null;
  /** Nulo sem snapshot de Full; positivo = anúncio com estoque no Full. */
  readonly fullQuantity: number | null;
}

export type ModoVincular =
  | { readonly tipo: "anuncio"; readonly anuncio: AnuncioAlvo }
  | {
      readonly tipo: "candidato";
      readonly candidateId: string;
      readonly skuInformado: string;
      readonly referencia: string;
      readonly accountLabel: string;
    }
  | { readonly tipo: "livre" };

export interface ContaOpcao {
  readonly id: string;
  readonly label: string;
}

/**
 * O tom do selo da conta, pela POSIÇÃO dela na lista que a página passou — a
 * mesma regra de `tonsDasContas`, para o selo do popup ter a cor do selo da
 * tabela. Conta que não está na lista (não deveria acontecer) cai no primeiro
 * tom em vez de sumir.
 */
function tomDaConta(contas: readonly ContaOpcao[], mlAccountId: string): number {
  const posicao = contas.findIndex((c) => c.id === mlAccountId);

  return posicao < 0 ? 0 : posicao % TONS_DE_CONTA;
}

type Carga =
  | { readonly estado: "carregando" }
  | { readonly estado: "pronto"; readonly plano: PlanoDeVinculo }
  | { readonly estado: "indisponivel" };

export function VincularDialog({
  modo,
  contas,
  onFechar,
  onConcluido,
  proximo,
}: {
  modo: ModoVincular;
  contas: readonly ContaOpcao[];
  onFechar: () => void;
  /** Vínculo gravado (ou candidato descartado): a tela atualiza a linha e recarrega os números. */
  onConcluido: (resultado: { itemId: string | null; sku: string | null; candidateId: string | null }) => void;
  /** Há outro sem vínculo na página: o botão "Vincular e próximo" aparece. */
  proximo?: () => void;
}): ReactNode {
  // O modo "livre" vira "anuncio" quando o MLB é encontrado.
  const [anuncio, setAnuncio] = useState<AnuncioAlvo | null>(modo.tipo === "anuncio" ? modo.anuncio : null);
  const [carga, setCarga] = useState<Carga>({ estado: "carregando" });
  const [alvoId, setAlvoId] = useState<string | null>(null);
  const [sku, setSku] = useState<OpcaoSku | null>(null);
  const [gravando, setGravando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [feitos, setFeitos] = useState<ReadonlyMap<string, string>>(new Map());

  // Esc fecha; a página por trás não rola enquanto o popup está aberto.
  useEffect(() => {
    const tecla = (evento: KeyboardEvent): void => {
      if (evento.key === "Escape" && !gravando) onFechar();
    };
    const overflow = document.body.style.overflow;

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", tecla);

    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener("keydown", tecla);
    };
  }, [onFechar, gravando]);

  // A sugestão do anúncio: uma leitura ao abrir (14–95 ms no Dev).
  useEffect(() => {
    if (anuncio === null) return;

    const estado = { vigente: true };

    setCarga({ estado: "carregando" });
    setErro(null);

    void (async () => {
      const { data, error } = await createClient().rpc("get_listing_link_suggestions", {
        p_ml_account_id: anuncio.mlAccountId,
        p_item_id: anuncio.itemId,
      });

      if (!estado.vigente) return;

      const lidas = error === null ? lerSugestoesDoAnuncio(data) : null;

      if (lidas === null) {
        // Sem a função (Preview antes da migration) ou falha: o popup segue,
        // só sem sugestão — a busca continua valendo.
        setCarga({ estado: "indisponivel" });
        setAlvoId(null);

        return;
      }

      const plano = planejarVinculo(lidas);
      const primeiro = plano.alvos.find((a) => a.vinculado === null) ?? null;

      setCarga({ estado: "pronto", plano });
      setAlvoId(primeiro?.variationId ?? null);
      setSku(primeiro?.sugestao ?? null);
    })();

    return () => {
      estado.vigente = false;
    };
  }, [anuncio]);

  const plano = carga.estado === "pronto" ? carga.plano : null;
  const alvo: AlvoSugerido | null = plano?.alvos.find((a) => a.variationId === alvoId) ?? plano?.alvos[0] ?? null;
  const chaveAlvo = alvoId ?? "__inteiro__";
  const alvoFeito = feitos.get(chaveAlvo) ?? null;
  const restantes = plano === null ? 0 : plano.alvos.filter((a) => a.vinculado === null && !feitos.has(a.variationId ?? "__inteiro__")).length;
  const ehFull = (anuncio?.fullQuantity ?? 0) > 0;

  function escolherAlvo(novo: AlvoSugerido): void {
    setAlvoId(novo.variationId);
    setSku(novo.sugestao);
    setErro(null);
  }

  async function vincular(depois: "fechar" | "proximo"): Promise<void> {
    if (sku === null) return;

    setGravando(true);
    setErro(null);

    const resultado =
      modo.tipo === "candidato"
        ? await resolveLinkCandidate(modo.candidateId, sku.skuId, { revalidar: false })
        : anuncio === null
          ? { ok: false, message: "Procure o anúncio antes de vincular." }
          : await createManualLink(
              {
                mlAccountId: anuncio.mlAccountId,
                itemId: anuncio.itemId,
                variationId: alvoId ?? "",
                skuId: sku.skuId,
              },
              { revalidar: false },
            );

    setGravando(false);

    if (!resultado.ok) {
      setErro(resultado.message ?? "Não foi possível vincular.");

      return;
    }

    onConcluido({
      itemId: anuncio?.itemId ?? null,
      sku: sku.sku,
      candidateId: modo.tipo === "candidato" ? modo.candidateId : null,
    });

    // Anúncio com variações: fica aberto até a última variação sem vínculo.
    const proximosAlvos =
      plano?.alvos.filter(
        (a) => a.vinculado === null && !feitos.has(a.variationId ?? "__inteiro__") && a.variationId !== alvoId,
      ) ?? [];

    setFeitos((atual) => new Map(atual).set(chaveAlvo, sku.sku));

    if (modo.tipo !== "candidato" && plano?.forma === "variacoes" && proximosAlvos.length > 0) {
      const seguinte = proximosAlvos[0];

      if (seguinte !== undefined) escolherAlvo(seguinte);

      return;
    }

    if (depois === "proximo" && proximo !== undefined) {
      proximo();

      return;
    }

    onFechar();
  }

  async function descartar(): Promise<void> {
    if (modo.tipo !== "candidato") return;

    setGravando(true);
    setErro(null);

    const resultado = await dismissLinkCandidate(modo.candidateId, { revalidar: false });

    setGravando(false);

    if (!resultado.ok) {
      setErro(resultado.message ?? "Não foi possível descartar.");

      return;
    }

    onConcluido({ itemId: null, sku: null, candidateId: modo.candidateId });
    onFechar();
  }

  const titulo =
    modo.tipo === "candidato"
      ? `Resolver o SKU ${modo.skuInformado}`
      : (anuncio?.title ?? (modo.tipo === "livre" ? "Vincular um MLB" : "Vincular anúncio"));

  return (
    <div
      className="sb-backdrop sb-vnc-fundo"
      onMouseDown={(evento) => {
        if (evento.target === evento.currentTarget && !gravando) onFechar();
      }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="vnc-titulo" className="sb-modal sb-vnc-modal">
        <header className="sb-vnc-topo">
          <div className="sb-vnc-topo-texto">
            <span className="sb-modal-eyebrow">
              {modo.tipo === "candidato" ? "CANDIDATO DO ERP" : "VINCULAR ANÚNCIO"}
            </span>
            <h2 id="vnc-titulo">{titulo}</h2>
            {anuncio !== null && (
              <p className="sb-vnc-meta">
                <Link className="sb-mono" href={`/anuncios/${anuncio.itemId}`} target="_blank">
                  {anuncio.itemId} ↗
                </Link>
                {/*
                  O MESMO selo da tabela (D-376): o tom sai da posição da conta
                  na lista que a página passou, então a cor aqui é a cor de lá.
                */}
                <span className="sb-vnc-conta-celula">
                  <span className="sb-vnc-selo" data-tom={tomDaConta(contas, anuncio.mlAccountId)} aria-hidden="true">
                    {iniciaisDaConta(anuncio.accountLabel)}
                  </span>
                  {anuncio.accountLabel}
                </span>
                {anuncio.price !== null && <span>{formatCurrency(anuncio.price)}</span>}
                {anuncio.unitsSold !== null && <span>{formatCount(anuncio.unitsSold)} vendido(s) em 30 dias</span>}
              </p>
            )}
            {modo.tipo === "candidato" && (
              <p className="sb-vnc-meta">
                <span className="sb-mono">{modo.referencia}</span>
                <span>{modo.accountLabel}</span>
              </p>
            )}
          </div>
          <button
            type="button"
            className="sb-close"
            aria-label="Fechar"
            disabled={gravando}
            onClick={onFechar}
          >
            ×
          </button>
        </header>

        <div className="sb-vnc-corpo">
          {modo.tipo === "livre" && anuncio === null && (
            <ProcurarMlb
              contas={contas}
              onEncontrado={(achado) => {
                setAnuncio(achado);
              }}
            />
          )}

          {ehFull && (
            <p className="sb-vnc-aviso" role="note">
              <b>Anúncio do Full.</b> Até a correção da baixa do Full (D-352), o vínculo faz as vendas deste anúncio
              baixarem o estoque da loja. Confira antes de vincular.
            </p>
          )}

          {anuncio !== null && carga.estado === "carregando" && (
            <div className="sb-vnc-carregando" aria-live="polite">
              <span className="sb-vnc-girando" aria-hidden="true" /> Lendo os pedidos deste anúncio para sugerir o
              SKU…
            </div>
          )}

          {anuncio !== null && carga.estado === "indisponivel" && (
            <p className="sb-vnc-nota">Sem sugestão agora — busque o SKU abaixo.</p>
          )}

          {plano !== null && plano.completo && (
            <p className="sb-vnc-sucesso" role="status">
              Este anúncio já está vinculado
              {plano.alvos[0]?.vinculado?.sku !== null && plano.alvos[0]?.vinculado?.sku !== undefined
                ? ` ao SKU ${plano.alvos[0].vinculado.sku}`
                : ""}
              . Para trocar o SKU, use a página do SKU — ela preserva o histórico dos pedidos.
            </p>
          )}

          {/* PARA QUAL PARTE: o anúncio inteiro, ou cada variação vista nos pedidos. */}
          {plano !== null && !plano.completo && plano.forma === "variacoes" && (
            <fieldset className="sb-vnc-alvos">
              <legend className="sb-vnc-rotulo">
                Variação <small>— vista nos pedidos, da que mais vende à que menos</small>
              </legend>
              {plano.alvos.map((a) => {
                const chave = a.variationId ?? "__inteiro__";
                const feito = feitos.get(chave);
                const bloqueado = a.vinculado !== null || feito !== undefined;

                return (
                  <label
                    key={chave}
                    className={[
                      "sb-vnc-alvo",
                      a.variationId === alvoId ? "sb-vnc-alvo-ativo" : "",
                      bloqueado ? "sb-vnc-alvo-feito" : "",
                    ].join(" ")}
                  >
                    <input
                      type="radio"
                      name="vnc-alvo"
                      checked={a.variationId === alvoId}
                      disabled={bloqueado || gravando}
                      onChange={() => {
                        escolherAlvo(a);
                      }}
                    />
                    <span className="sb-vnc-alvo-texto">
                      <b className="sb-mono">Variação {a.variationId}</b>
                      <small>
                        {formatCount(a.unidades)} un vendidas
                        {a.vinculado !== null
                          ? ` · já vinculada${a.vinculado.sku === null ? "" : ` ao ${a.vinculado.sku}`}`
                          : feito !== undefined
                            ? ` · vinculada agora ao ${feito}`
                            : a.sugestao !== null
                              ? ` · sugestão ${a.sugestao.sku}`
                              : a.opcoes.length > 1 || (a.opcoes.length > 0 && a.semCadastro.length > 0)
                                ? " · códigos diferentes nos pedidos: confira"
                                : a.semCadastro.length > 0
                                  ? ` · código ${a.semCadastro[0] ?? ""} fora do catálogo`
                                  : ""}
                      </small>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          )}

          {plano !== null && !plano.completo && plano.forma === "inteiro" && (
            <p className="sb-vnc-nota">
              Vínculo do <b>anúncio inteiro</b>
              {alvo !== null && alvo.unidades > 0
                ? ` — ${formatCount(alvo.unidades)} un vendidas, nenhuma com variação.`
                : " — nenhum pedido com variação."}
            </p>
          )}

          {/* O SKU: a sugestão dos pedidos, as outras opções vistas, e a busca. */}
          {(modo.tipo === "candidato" || (anuncio !== null && carga.estado !== "carregando" && plano?.completo !== true)) &&
            alvoFeito === null && (
              <>
                {alvo !== null && alvo.opcoes.length > 0 && (
                  <div className="sb-vnc-opcoes">
                    <span className="sb-vnc-rotulo">
                      {alvo.sugestao !== null ? "Sugestão dos pedidos" : "SKUs vistos nos pedidos"}
                      {alvo.sugestao === null && alvo.opcoes.length > 1 && (
                        <small> — mais de um: escolha o certo</small>
                      )}
                    </span>
                    {alvo.opcoes.map((opcao) => (
                      <button
                        key={opcao.skuId}
                        type="button"
                        className={
                          sku?.skuId === opcao.skuId ? "sb-button sb-vnc-opcao sb-vnc-opcao-ativa" : "sb-button sb-vnc-opcao"
                        }
                        aria-pressed={sku?.skuId === opcao.skuId}
                        onClick={() => {
                          setSku(opcao);
                        }}
                      >
                        <b className="sb-mono">{opcao.sku}</b>
                        <span>{opcao.title ?? "sem título"}</span>
                        {alvo.sugestao?.skuId === opcao.skuId && <em>sugerido</em>}
                      </button>
                    ))}
                    {alvo.semCadastro.length > 0 && (
                      <p className="sb-vnc-nota">
                        Nos pedidos também aparece {alvo.semCadastro.map((c) => `“${c}”`).join(", ")}, que não existe
                        no catálogo.
                      </p>
                    )}
                  </div>
                )}

                <BuscaSku
                  key={`${anuncio?.itemId ?? ""}:${chaveAlvo}`}
                  inicial={modo.tipo === "candidato" ? modo.skuInformado : ""}
                  autoFocus={alvo?.sugestao == null}
                  onEscolher={(opcao) => {
                    setSku(opcao);
                    setErro(null);
                  }}
                />

                {sku !== null && (
                  <div className="sb-vnc-escolhido" role="status">
                    <span className="sb-vnc-seta" aria-hidden="true">
                      →
                    </span>
                    <span>
                      {alvoId === null ? "Anúncio inteiro" : `Variação ${alvoId}`} vai para o SKU{" "}
                      <b className="sb-mono">{sku.sku}</b>
                      {sku.title !== null && <small>{sku.title}</small>}
                    </span>
                  </div>
                )}
              </>
            )}

          {feitos.size > 0 && restantes > 0 && (
            <p className="sb-vnc-sucesso" role="status">
              {formatCount(feitos.size)} variação(ões) vinculada(s). Falta(m) {formatCount(restantes)}.
            </p>
          )}

          {erro !== null && (
            <p role="alert" className="sb-vnc-erro">
              {erro}
            </p>
          )}
        </div>

        <footer className="sb-vnc-rodape">
          {modo.tipo === "candidato" ? (
            <button type="button" className="sb-button" disabled={gravando} onClick={() => void descartar()}>
              Descartar candidato
            </button>
          ) : (
            <span />
          )}
          <span className="sb-vnc-espaco" />
          <button type="button" className="sb-button" disabled={gravando} onClick={onFechar}>
            {feitos.size > 0 ? "Fechar" : "Cancelar"}
          </button>
          {proximo !== undefined && modo.tipo === "anuncio" && (
            <button
              type="button"
              className="sb-button"
              disabled={gravando || sku === null || plano?.completo === true || alvoFeito !== null}
              onClick={() => void vincular("proximo")}
            >
              Vincular e próximo
            </button>
          )}
          <button
            type="button"
            className="sb-button sb-button-primary"
            disabled={gravando || sku === null || plano?.completo === true || alvoFeito !== null || (modo.tipo === "livre" && anuncio === null)}
            onClick={() => void vincular("fechar")}
          >
            {gravando ? "Vinculando…" : "Vincular"}
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * O MLB digitado à mão (modo "livre"): conferido no catálogo sincronizado
 * ANTES de vincular — `create_sku_listing_link` não confere se o anúncio
 * existe, e um MLB errado viraria vínculo morto (D-316).
 */
function ProcurarMlb({
  contas,
  onEncontrado,
}: {
  contas: readonly ContaOpcao[];
  onEncontrado: (anuncio: AnuncioAlvo) => void;
}): ReactNode {
  const [conta, setConta] = useState(contas[0]?.id ?? "");
  const [mlb, setMlb] = useState("");
  const [procurando, setProcurando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  async function procurar(): Promise<void> {
    const itemId = mlb.trim().toUpperCase();

    if (!/^MLB[0-9]+$/.test(itemId)) {
      setAviso("O MLB tem a forma MLB seguido de números.");

      return;
    }

    setProcurando(true);
    setAviso(null);

    // Por (conta, anúncio): buscar só pelo MLB acharia o de outra conta.
    const { data, error } = await createClient()
      .from("listings")
      .select("item_id, title, price, synced_at")
      .eq("ml_account_id", conta)
      .eq("item_id", itemId)
      .maybeSingle();

    setProcurando(false);

    if (error !== null) {
      setAviso("Não foi possível consultar o catálogo agora.");

      return;
    }

    if (data === null) {
      setAviso(
        "Não encontramos este MLB no catálogo sincronizado desta conta. Pode ser MLB errado, conta não conectada ou anúncio novo (o catálogo sincroniza de 6 em 6 horas) — sem confirmar que ele existe, não vinculamos.",
      );

      return;
    }

    onEncontrado({
      mlAccountId: conta,
      accountLabel: contas.find((c) => c.id === conta)?.label ?? "",
      itemId: data.item_id,
      title: `${data.title} · sincronizado ${formatDateTime(data.synced_at)}`,
      price: data.price,
      unitsSold: null,
      fullQuantity: null,
    });
  }

  return (
    <form
      className="sb-vnc-procurar"
      onSubmit={(evento) => {
        evento.preventDefault();
        void procurar();
      }}
    >
      <label className="sb-form-campo" htmlFor="vnc-conta">
        <span className="sb-vnc-rotulo">Conta</span>
        <select
          id="vnc-conta"
          className="sb-input sb-input-full"
          value={conta}
          onChange={(evento) => {
            setConta(evento.target.value);
          }}
        >
          {contas.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className="sb-form-campo" htmlFor="vnc-mlb">
        <span className="sb-vnc-rotulo">MLB do anúncio</span>
        <input
          id="vnc-mlb"
          className="sb-input sb-input-full sb-mono"
          value={mlb}
          placeholder="MLB123456789"
          spellCheck={false}
          autoFocus
          onChange={(evento) => {
            setMlb(evento.target.value);
            setAviso(null);
          }}
        />
      </label>
      <button type="submit" className="sb-button sb-button-primary" disabled={procurando || mlb.trim() === ""}>
        {procurando ? "Procurando…" : "Procurar"}
      </button>
      {aviso !== null && (
        <p role="alert" className="sb-vnc-erro sb-vnc-largo">
          {aviso}
        </p>
      )}
    </form>
  );
}
