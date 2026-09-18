"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition, type ReactNode } from "react";

import { Icone } from "../../components/icons";
import { TOM, type Tom } from "../../components/tone";
import { formatCount, formatCurrency, formatDateTime } from "../../lib/format";
import { iniciaisDaConta } from "../../lib/vinculacoes-visao";

import { VincularDialog, type AnuncioAlvo, type ContaOpcao, type ModoVincular } from "./vincular-dialog";

/**
 * As partes de /vinculacoes que abrem o popup (D-374): a tabela de anúncios, a
 * fila de candidatos do ERP e o "vincular por MLB".
 *
 * **Sem navegação e sem esperar a página.** A ação grava com `revalidar:
 * false`, a linha muda NA HORA ("vinculado agora → SKU"), e o `router.refresh()`
 * roda em segundo plano, numa transição: os números se atualizam quando
 * chegarem, sem travar o próximo vínculo.
 *
 * **D-376, o acabamento.** A conta saiu da própria coluna e virou um selo de
 * duas letras junto do MLB: ela aparece em toda linha, e uma coluna de texto
 * para ela empurrava o título — que é o que a pessoa lê para reconhecer o
 * anúncio. A venda agora traz a RECEITA embaixo, porque "vendeu 124" e "vendeu
 * R$ 36 mil sem baixar estoque" pedem urgências diferentes, e a tabela já vem
 * ordenada por esse número.
 */

export interface LinhaAnuncio {
  readonly listingId: string;
  readonly itemId: string;
  readonly title: string;
  readonly mlAccountId: string;
  readonly accountLabel: string;
  /** O tom do selo da conta, pela posição dela na lista da tela (D-376). */
  readonly contaTom: number;
  readonly sku: string | null;
  readonly skuId: string | null;
  readonly linkState: string;
  readonly unitsSold: number;
  /** Receita da janela — o que está entrando sem baixa de estoque (D-376). */
  readonly grossRevenue: number;
  readonly price: number;
  readonly fullQuantity: number | null;
}

function estadoDoVinculo(linkState: string): { rotulo: string; tom: Tom } {
  if (linkState === "linked") return { rotulo: "Vinculado", tom: "ok" };
  if (linkState === "linked_variation") return { rotulo: "Por variação", tom: "info" };

  return { rotulo: "Sem vínculo", tom: "perigo" };
}

function alvoDaLinha(linha: LinhaAnuncio): AnuncioAlvo {
  return {
    mlAccountId: linha.mlAccountId,
    accountLabel: linha.accountLabel,
    itemId: linha.itemId,
    title: linha.title,
    price: linha.price,
    unitsSold: linha.unitsSold,
    fullQuantity: linha.fullQuantity,
  };
}

/** O refresh em segundo plano, compartilhado pelas três partes. */
function useAtualizarEmSegundoPlano(): { atualizar: () => void; atualizando: boolean } {
  const router = useRouter();
  const [atualizando, startTransition] = useTransition();

  const atualizar = useCallback(() => {
    startTransition(() => {
      router.refresh();
    });
  }, [router]);

  return { atualizar, atualizando };
}

export function TabelaVinculos({
  linhas,
  contas,
  abrirItem,
  janelaDias,
}: {
  linhas: readonly LinhaAnuncio[];
  contas: readonly ContaOpcao[];
  /** `?item=` na URL (link de outra tela): abre o popup direto nesse anúncio. */
  abrirItem: string | null;
  janelaDias: number;
}): ReactNode {
  const { atualizar, atualizando } = useAtualizarEmSegundoPlano();
  const [aberto, setAberto] = useState<LinhaAnuncio | null>(null);
  // Vínculos feitos nesta visita, por MLB — valem até o refresh trazer o dado do banco.
  const [feitos, setFeitos] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    if (abrirItem === null) return;

    const linha = linhas.find((l) => l.itemId === abrirItem.toUpperCase());

    if (linha !== undefined) setAberto(linha);
    // Só na chegada: a URL é o convite, não um controle — o popup não reabre a
    // cada refresh das linhas.
  }, [abrirItem]);

  const semVinculo = (l: LinhaAnuncio): boolean => l.linkState === "unlinked" && !feitos.has(l.itemId);

  function proximoDepoisDe(atual: LinhaAnuncio): LinhaAnuncio | null {
    const indice = linhas.findIndex((l) => l.listingId === atual.listingId);

    return [...linhas.slice(indice + 1), ...linhas.slice(0, Math.max(indice, 0))].find(semVinculo) ?? null;
  }

  const proximo = aberto === null ? null : proximoDepoisDe(aberto);

  return (
    <>
      {atualizando && (
        <span className="sb-vnc-atualizando" role="status">
          <span className="sb-vnc-girando" aria-hidden="true" /> atualizando os números…
        </span>
      )}

      <div className="sb-vnc-tabela-rolagem">
        <table className="sb-table sb-vnc-tabela">
          <thead>
            <tr>
              <th>Anúncio</th>
              <th>SKU no sistema</th>
              <th>Estado</th>
              <th className="sb-num">Vendas ({janelaDias}d)</th>
              <th className="sb-num">Preço</th>
              <th>
                <span className="sb-sr-only">Ação</span>
              </th>
            </tr>
          </thead>

          <tbody>
            {linhas.map((linha) => {
              const vinculadoAgora = feitos.get(linha.itemId) ?? null;
              const estado: { rotulo: string; tom: Tom } =
                vinculadoAgora === null ? estadoDoVinculo(linha.linkState) : { rotulo: "Vinculado agora", tom: "ok" };
              const vendeuSemVinculo = linha.unitsSold > 0 && semVinculo(linha);

              return (
                <tr
                  key={linha.listingId}
                  className={[
                    vendeuSemVinculo ? "sb-vnc-linha-urgente" : "",
                    vinculadoAgora !== null ? "sb-vnc-linha-feita" : "",
                  ].join(" ")}
                >
                  <td>
                    <div className="sb-vnc-anuncio">
                      <Link className="sb-entity" href={`/anuncios/${linha.itemId}`}>
                        {linha.title}
                      </Link>
                      <span className="sb-vnc-anuncio-pe">
                        <span
                          className="sb-vnc-selo"
                          data-tom={linha.contaTom}
                          title={linha.accountLabel}
                        >
                          {iniciaisDaConta(linha.accountLabel)}
                        </span>
                        <span className="sb-mono">{linha.itemId}</span>
                        {(linha.fullQuantity ?? 0) > 0 && <em className="sb-vnc-full">Full</em>}
                      </span>
                    </div>
                  </td>
                  {/* Vínculo por variação não tem `sku_id`, e está ligado: o "—" vem com o estado ao lado. */}
                  <td className="sb-mono">
                    {vinculadoAgora !== null ? (
                      <b>{vinculadoAgora}</b>
                    ) : linha.skuId === null ? (
                      <span className="sb-vnc-mudo">—</span>
                    ) : (
                      <Link href={`/skus/${linha.skuId}`}>{linha.sku}</Link>
                    )}
                  </td>
                  <td>
                    <span className="sb-status" style={TOM[estado.tom]}>
                      {estado.rotulo}
                    </span>
                  </td>
                  <td className="sb-num">
                    <span className={vendeuSemVinculo ? "sb-vnc-vendas-alerta" : undefined}>
                      {formatCount(linha.unitsSold)}
                    </span>
                    {linha.unitsSold > 0 && (
                      <small className={vendeuSemVinculo ? "sb-vnc-bloco sb-vnc-risco" : "sb-vnc-bloco"}>
                        {formatCurrency(linha.grossRevenue)}
                      </small>
                    )}
                  </td>
                  <td className="sb-num">{formatCurrency(linha.price)}</td>
                  <td className="sb-vnc-acao">
                    {semVinculo(linha) ? (
                      <button
                        type="button"
                        className="sb-button sb-button-sm sb-vnc-vincular"
                        onClick={() => {
                          setAberto(linha);
                        }}
                      >
                        <Icone nome="corrente" tamanho={12} />
                        Vincular
                      </button>
                    ) : vinculadoAgora !== null ? (
                      <span className="sb-vnc-ok" aria-label="vinculado agora">
                        ✓
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {aberto !== null && (
        <VincularDialog
          // Trocar de anúncio (o "próximo") remonta o popup do zero.
          key={aberto.listingId}
          modo={{ tipo: "anuncio", anuncio: alvoDaLinha(aberto) }}
          contas={contas}
          onFechar={() => {
            setAberto(null);
          }}
          onConcluido={({ itemId, sku }) => {
            if (itemId !== null && sku !== null) setFeitos((atual) => new Map(atual).set(itemId, sku));
            atualizar();
          }}
          {...(proximo === null
            ? {}
            : {
                proximo: () => {
                  setAberto(proximo);
                },
              })}
        />
      )}
    </>
  );
}

export interface CandidatoLinha {
  readonly id: string;
  readonly skuKey: string;
  readonly accountLabel: string;
  readonly referencia: string;
  readonly createdAt: string;
}

export function FilaCandidatos({
  candidatos,
  contas,
}: {
  candidatos: readonly CandidatoLinha[];
  contas: readonly ContaOpcao[];
}): ReactNode {
  const { atualizar } = useAtualizarEmSegundoPlano();
  const [aberto, setAberto] = useState<CandidatoLinha | null>(null);
  const [resolvidos, setResolvidos] = useState<ReadonlySet<string>>(new Set());

  const visiveis = candidatos.filter((c) => !resolvidos.has(c.id));

  if (visiveis.length === 0) {
    return (
      <p className="sb-empty">
        Nenhum candidato pendente — toda linha do ERP encontrou o seu SKU. As linhas de outros canais de venda não
        entram nesta fila por desenho.
      </p>
    );
  }

  return (
    <>
      <div className="sb-vnc-tabela-rolagem">
        <table className="sb-table">
          <thead>
            <tr>
              <th>SKU informado</th>
              <th>Conta</th>
              <th>Referência</th>
              <th>Desde</th>
              <th>
                <span className="sb-sr-only">Ação</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visiveis.map((c) => (
              <tr key={c.id}>
                <td className="sb-mono">{c.skuKey}</td>
                <td>{c.accountLabel}</td>
                <td className="sb-mono">{c.referencia}</td>
                <td>{formatDateTime(c.createdAt)}</td>
                <td className="sb-vnc-acao">
                  <button
                    type="button"
                    className="sb-button sb-button-sm sb-vnc-vincular"
                    onClick={() => {
                      setAberto(c);
                    }}
                  >
                    Resolver
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {aberto !== null && (
        <VincularDialog
          key={aberto.id}
          modo={{
            tipo: "candidato",
            candidateId: aberto.id,
            skuInformado: aberto.skuKey,
            referencia: aberto.referencia,
            accountLabel: aberto.accountLabel,
          }}
          contas={contas}
          onFechar={() => {
            setAberto(null);
          }}
          onConcluido={({ candidateId }) => {
            if (candidateId !== null) setResolvidos((atual) => new Set(atual).add(candidateId));
            atualizar();
          }}
        />
      )}
    </>
  );
}

export function VincularPorMlb({ contas }: { contas: readonly ContaOpcao[] }): ReactNode {
  const { atualizar } = useAtualizarEmSegundoPlano();
  const [aberto, setAberto] = useState(false);
  const [ultimo, setUltimo] = useState<string | null>(null);

  if (contas.length === 0) return null;

  const modo: ModoVincular = { tipo: "livre" };

  return (
    <>
      <button
        type="button"
        className="sb-button sb-button-primary"
        onClick={() => {
          setAberto(true);
          setUltimo(null);
        }}
      >
        <Icone nome="corrente" tamanho={14} />
        Vincular um MLB
      </button>
      {ultimo !== null && (
        <span className="sb-vnc-ultimo" role="status">
          {ultimo}
        </span>
      )}

      {aberto && (
        <VincularDialog
          modo={modo}
          contas={contas}
          onFechar={() => {
            setAberto(false);
          }}
          onConcluido={({ itemId, sku }) => {
            if (itemId !== null && sku !== null) setUltimo(`${itemId} vinculado ao SKU ${sku}.`);
            atualizar();
          }}
        />
      )}
    </>
  );
}
