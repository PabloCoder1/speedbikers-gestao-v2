"use client";

import { useState, type ReactNode } from "react";

import { PainelAnalise, SeloRecomendacao, SeloSituacao } from "../../../../components/analise-compra";
import { formatCount, formatCurrency } from "../../../../lib/format";
import {
  MOTIVOS_MANTER,
  contextoDoMotivo,
  fraseDoMotivo,
  motivosOrdenados,
  type MotivoManter,
} from "../../../../lib/purchase-fit-vocabulary";

import {
  CLASSE_REVISAO,
  ORDEM_CLASSES,
  classificarParaRevisao,
  planoDoLote,
  quantidadeParaReduzir,
  type ClasseRevisao,
  type DecisaoItem,
  type ImpactoRevisao,
  type ItemRetirado,
  type LinhaRevisao,
} from "./revisao-pedido";
import type { AnalisePedido, EstadoAnalise } from "./use-analise-pedido";

/**
 * A revisão do pedido antes de confirmar (D-722).
 *
 * Mostra primeiro o que merece atenção — retirar, avaliar, margem, sem dados —
 * e deixa os "recomendados para compra" recolhidos. Cada item questionável tem
 * as quatro ações (manter, reduzir, retirar, ver análise); manter o que o
 * sistema mandava retirar ou reduzir abre a justificativa, opcional e de um
 * clique. O lote aplica as recomendações de uma vez, e cada item continua
 * reversível. Nada é retirado sem o clique do comprador.
 */

interface Props {
  readonly linhas: readonly LinhaRevisao[];
  readonly retirados: readonly ItemRetirado[];
  readonly decisoes: ReadonlyMap<string, DecisaoItem>;
  readonly analise: AnalisePedido | null;
  readonly estado: EstadoAnalise;
  readonly foraDoLimite: number;
  readonly impacto: ImpactoRevisao;
  readonly onManter: (key: string, reason: MotivoManter | null, note: string) => void;
  readonly onReduzir: (key: string, quantidade: number) => void;
  readonly onRetirar: (key: string) => void;
  readonly onDesfazerRetirada: (key: string) => void;
  readonly onLote: (plano: ReturnType<typeof planoDoLote>) => void;
}

function Linha({
  linha,
  decisao,
  analise,
  onManter,
  onReduzir,
  onRetirar,
}: {
  linha: LinhaRevisao;
  decisao: DecisaoItem | undefined;
  analise: AnalisePedido;
  onManter: Props["onManter"];
  onReduzir: Props["onReduzir"];
  onRetirar: Props["onRetirar"];
}): ReactNode {
  const [justificando, setJustificando] = useState(false);
  const [motivo, setMotivo] = useState<MotivoManter | "">(decisao?.reason ?? "");
  const [nota, setNota] = useState(decisao?.note ?? "");
  const av = linha.avaliacao;
  const fit = av?.fit ?? null;
  const reduzirPara = quantidadeParaReduzir(linha);
  const rec = fit?.recommendation ?? null;
  const pedeJustificativa = rec === "RETIRAR" || rec === "REDUZIR" || rec === "REVISAR";
  const principal =
    fit === null || av === null
      ? null
      : (() => {
          const m = motivosOrdenados(fit)[0];

          if (m === undefined) return null;

          const usavel = av.linha.stock_is_virtual ? null : av.linha.local_quantity + av.linha.full_quantity + av.linha.transito;

          return fraseDoMotivo(
            m.code,
            contextoDoMotivo(fit, {
              units30d: av.linha.units_30d,
              estoque: usavel,
              sugestao: null,
              noPedido: linha.quantidade,
              margem: av.margem?.total?.avaliacao.margin ?? null,
              margemMinima: analise.margemMinima,
              diasRuptura: av.linha.stockoutDays30,
              outrosPedidos: av.linha.otherOpenQuantity,
              tetoDias: null,
            }),
          );
        })();

  return (
    <li className="sb-rev-item">
      <div className="sb-rev-item-topo">
        <div className="sb-rev-item-sku">
          <b>{linha.sku}</b>
          <span>
            no pedido {linha.quantidade === null ? "—" : formatCount(linha.quantidade)} un
            {fit?.recommendedQuantity !== null && fit?.recommendedQuantity !== undefined && (
              <> · o sistema compraria {formatCount(fit.recommendedQuantity)}</>
            )}
          </span>
        </div>
        <div className="sb-rev-selos">
          {av !== null && <SeloSituacao avaliacao={av} />}
          {av !== null && <SeloRecomendacao avaliacao={av} />}
          {decisao !== undefined && (
            <span className="sb-rev-decidido">
              decidido: {decisao.decision === "MANTER" ? "manter" : decisao.decision === "REDUZIR" ? "reduzir" : "retirar"}
            </span>
          )}
        </div>
      </div>

      {principal !== null && <p className="sb-rev-motivo">{principal}</p>}

      <div className="sb-rev-acoes" role="group" aria-label={`Decisão sobre ${linha.sku}`}>
        <button
          type="button"
          className={decisao?.decision === "MANTER" ? "sb-button sb-button-primary" : "sb-button"}
          aria-pressed={decisao?.decision === "MANTER"}
          onClick={() => {
            if (pedeJustificativa) setJustificando((v) => !v);
            else onManter(linha.key, null, "");
          }}
        >
          Manter
        </button>
        {reduzirPara !== null && (
          <button
            type="button"
            className={decisao?.decision === "REDUZIR" ? "sb-button sb-button-primary" : "sb-button"}
            aria-pressed={decisao?.decision === "REDUZIR"}
            onClick={() => {
              onReduzir(linha.key, reduzirPara);
            }}
          >
            Reduzir para {formatCount(reduzirPara)}
          </button>
        )}
        <button
          type="button"
          className="sb-button"
          onClick={() => {
            onRetirar(linha.key);
          }}
        >
          Retirar do pedido
        </button>
        {av !== null && (
          <details className="sb-cmp-detalhes sb-rev-analise">
            <summary>
              <span className="sb-cmp-ver">Ver análise</span>
            </summary>
            <PainelAnalise
              avaliacao={av}
              margemMinima={analise.margemMinima}
              periodoMargem={analise.periodo}
              lojasTiktok={analise.lojasTiktok}
              sugestao={null}
              noPedido={linha.quantidade}
              tetoDias={null}
            />
          </details>
        )}
      </div>

      {justificando && (
        <div className="sb-rev-justificativa">
          <label className="sb-form-campo">
            <span>Por que manter? (opcional)</span>
            <select
              className="sb-input"
              value={motivo}
              onChange={(e) => {
                setMotivo(e.target.value as MotivoManter | "");
              }}
            >
              <option value="">Sem motivo informado</option>
              {MOTIVOS_MANTER.map((m) => (
                <option key={m.valor} value={m.valor}>
                  {m.rotulo}
                </option>
              ))}
            </select>
          </label>
          <label className="sb-form-campo">
            <span>Observação (opcional)</span>
            <input
              className="sb-input"
              maxLength={500}
              value={nota}
              onChange={(e) => {
                setNota(e.target.value);
              }}
              placeholder="Ex.: campanha de dezembro"
            />
          </label>
          <button
            type="button"
            className="sb-button sb-button-primary"
            onClick={() => {
              onManter(linha.key, motivo === "" ? null : motivo, nota);
              setJustificando(false);
            }}
          >
            Confirmar manter
          </button>
        </div>
      )}
    </li>
  );
}

export function RevisaoPedido(p: Props): ReactNode {
  const [verRecomendados, setVerRecomendados] = useState(false);
  const comSku = p.linhas.filter((l) => l.skuId !== null && l.quantidade !== null);

  if (comSku.length === 0 && p.retirados.length === 0) return null;

  const porClasse = new Map<ClasseRevisao, LinhaRevisao[]>();

  for (const l of comSku) {
    const c = classificarParaRevisao(l.avaliacao);

    porClasse.set(c, [...(porClasse.get(c) ?? []), l]);
  }

  const analise = p.analise;
  const plano = planoDoLote(comSku.filter((l) => p.decisoes.get(l.key) === undefined));
  const atencao = ORDEM_CLASSES.filter((c) => c !== "COMPRAR").reduce((s, c) => s + (porClasse.get(c)?.length ?? 0), 0);

  return (
    <section className="sb-pco-cartao sb-rev" aria-labelledby="pco-revisao">
      <header className="sb-pco-cartao-topo">
        <span className="sb-pco-passo" aria-hidden="true">
          ✓
        </span>
        <div>
          <h2 id="pco-revisao">Revisão antes de confirmar</h2>
          <p>
            Venda, estoque, pedidos em aberto e margem de {String(30)} dias de cada SKU. A decisão é sua: nada sai do pedido sem o
            seu clique, e retirar do pedido não mexe no catálogo, nos anúncios nem no estoque.
          </p>
        </div>
        {plano.length > 0 && analise !== null && (
          <div className="sb-pco-cartao-acoes">
            <button
              type="button"
              className="sb-button"
              onClick={() => {
                p.onLote(plano);
              }}
            >
              Aplicar as recomendações ({formatCount(plano.length)})
            </button>
          </div>
        )}
      </header>

      {p.estado === "carregando" && analise === null && (
        <p className="sb-rev-status" role="status">
          Analisando os itens…
        </p>
      )}
      {p.estado === "indisponivel" && (
        <p className="sb-pco-aviso" role="alert">
          A análise de compra não carregou agora. O pedido continua normal — revise as quantidades pela reposição.
        </p>
      )}
      {p.foraDoLimite > 0 && (
        <p className="sb-pco-aviso">{formatCount(p.foraDoLimite)} SKU(s) além dos 500 primeiros ficaram sem análise.</p>
      )}

      {analise !== null && (
        <>
          <ul className="sb-rev-classes" aria-label="Itens por situação">
            {ORDEM_CLASSES.map((c) => (
              <li key={c} className={`sb-rev-classe sb-rev-classe-${c.toLowerCase()}`}>
                <strong>{formatCount(porClasse.get(c)?.length ?? 0)}</strong>
                <span>{CLASSE_REVISAO[c]}</span>
              </li>
            ))}
          </ul>

          {atencao === 0 && p.retirados.length === 0 && (
            <p className="sb-rev-status">Nenhum item pede atenção: todos estão dentro do que o sistema recomendaria.</p>
          )}

          {ORDEM_CLASSES.filter((c) => c !== "COMPRAR").map((c) => {
            const linhas = porClasse.get(c) ?? [];

            if (linhas.length === 0) return null;

            return (
              <div key={c} className="sb-rev-grupo">
                <h3>{CLASSE_REVISAO[c]}</h3>
                <ul className="sb-rev-lista">
                  {linhas.map((l) => (
                    <Linha
                      key={l.key}
                      linha={l}
                      decisao={p.decisoes.get(l.key)}
                      analise={analise}
                      onManter={p.onManter}
                      onReduzir={p.onReduzir}
                      onRetirar={p.onRetirar}
                    />
                  ))}
                </ul>
              </div>
            );
          })}

          {(porClasse.get("COMPRAR")?.length ?? 0) > 0 && (
            <div className="sb-rev-grupo">
              <button
                type="button"
                className="sb-text-button"
                aria-expanded={verRecomendados}
                onClick={() => {
                  setVerRecomendados((v) => !v);
                }}
              >
                {verRecomendados ? "Ocultar" : "Ver"} os {formatCount(porClasse.get("COMPRAR")?.length ?? 0)} recomendados para compra
              </button>
              {verRecomendados && (
                <ul className="sb-rev-lista">
                  {(porClasse.get("COMPRAR") ?? []).map((l) => (
                    <Linha
                      key={l.key}
                      linha={l}
                      decisao={p.decisoes.get(l.key)}
                      analise={analise}
                      onManter={p.onManter}
                      onReduzir={p.onReduzir}
                      onRetirar={p.onRetirar}
                    />
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}

      {p.retirados.length > 0 && (
        <div className="sb-rev-grupo">
          <h3>Retirados deste pedido</h3>
          <ul className="sb-rev-lista">
            {p.retirados.map((r) => (
              <li key={r.key} className="sb-rev-item sb-rev-item-retirado">
                <div className="sb-rev-item-topo">
                  <div className="sb-rev-item-sku">
                    <b>{r.sku}</b>
                    <span>
                      {formatCount(r.quantidade)} un{r.custo !== null && ` · ${formatCurrency(r.quantidade * r.custo)}`}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="sb-button"
                    onClick={() => {
                      p.onDesfazerRetirada(r.key);
                    }}
                  >
                    Desfazer
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(p.impacto.retirados > 0 || p.impacto.reduzidos > 0) && (
        <p className="sb-rev-impacto" role="status">
          {p.impacto.retirados > 0 && (
            <>
              {formatCount(p.impacto.retirados)} item(ns) retirado(s), {formatCount(p.impacto.unidadesRetiradas)} un
              {p.impacto.valorRetirado !== null && <> · {formatCurrency(p.impacto.valorRetirado)}</>}.{" "}
            </>
          )}
          {p.impacto.reduzidos > 0 && (
            <>
              {formatCount(p.impacto.reduzidos)} reduzido(s), {formatCount(p.impacto.unidadesReduzidas)} un a menos.{" "}
            </>
          )}
          <small>É redução do pedido planejado, não economia realizada.</small>
        </p>
      )}
    </section>
  );
}
