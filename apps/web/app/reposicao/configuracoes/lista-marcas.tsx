"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { TOM, type Tom } from "../../../components/tone";
import { formatCount } from "../../../lib/format";
import type { Alcance, Governo } from "../../../lib/replenishment-reach";

import { AbrirRegra, type OpcaoDeEscopo, type RegraExistente } from "./gaveta-regra";
import { ReguaPolitica } from "./regua-politica";

/**
 * AS MARCAS (D-361) — uma linha por marca do catálogo, e não uma por regra.
 *
 * A tabela de D-144 listava só o que já estava configurado. Com zero regras (o
 * caso de produção no dia desta fatia) ela era uma frase vazia, e a pergunta
 * "quais marcas faltam?" não tinha resposta na tela. Agora toda marca aparece,
 * com quem a governa hoje — regra própria, o padrão, ou nada — e a ordem é a de
 * quem mais destrava: venda recente primeiro.
 *
 * O filtro e a busca são do cliente: são 17 marcas, e ir ao servidor para
 * recortar uma lista que já está na página seria uma ida sem ganho.
 */

export interface LinhaDeMarca {
  readonly marca: string;
  readonly skus: number;
  readonly naReposicao: number;
  readonly comVenda30d: number;
  /** "ORFA" = regra de uma marca que saiu do catálogo. */
  readonly governo: Governo | "ORFA";
  readonly regra: RegraExistente | null;
}

type Filtro = "todas" | "sem-regra" | "propria" | "padrao";

const GOVERNO: Record<LinhaDeMarca["governo"], { rotulo: string; tom: Tom; dica: string }> = {
  MARCA: { rotulo: "Regra própria", tom: "ok", dica: "a regra desta marca vence o padrão" },
  PADRAO: { rotulo: "Usa o padrão", tom: "neutro", dica: "sem regra própria, segue o padrão da organização" },
  NENHUMA: { rotulo: "Sem regra", tom: "perigo", dica: "sem regra própria nem padrão: a reposição recusa sugestão" },
  ORFA: { rotulo: "Fora do catálogo", tom: "atencao", dica: "nenhum SKU do catálogo tem esta marca: a regra não governa nada" },
};

function politica(regra: RegraExistente, herdada: boolean): ReactNode {
  return (
    <div className={herdada ? "sb-cfg-politica sb-cfg-politica-herdada" : "sb-cfg-politica"}>
      <span className="sb-cfg-politica-numeros">
        {regra.prazo}d prazo · {regra.seguranca}d seg. · {regra.cobertura}d cob.
        {regra.teto !== null && ` · teto ${String(regra.teto)}d`}
        {herdada && <em> (do padrão)</em>}
      </span>
      <ReguaPolitica
        prazo={regra.prazo}
        cobertura={regra.cobertura}
        seguranca={regra.seguranca}
        teto={regra.teto}
        compacta
      />
    </div>
  );
}

export function ListaDeMarcas({
  linhas,
  padrao,
  totalNaReposicao,
  opcoes,
  alcance,
  podeEditar,
}: {
  linhas: readonly LinhaDeMarca[];
  padrao: RegraExistente | null;
  totalNaReposicao: number;
  opcoes: readonly OpcaoDeEscopo[];
  alcance: Alcance | null;
  podeEditar: boolean;
}): ReactNode {
  const [filtro, setFiltro] = useState<Filtro>("todas");
  const [busca, setBusca] = useState("");

  const contagem: Record<Filtro, number> = {
    todas: linhas.length,
    "sem-regra": linhas.filter((l) => l.governo === "NENHUMA").length,
    propria: linhas.filter((l) => l.governo === "MARCA" || l.governo === "ORFA").length,
    padrao: linhas.filter((l) => l.governo === "PADRAO").length,
  };

  const termo = busca.trim().toLocaleUpperCase("pt-BR");
  const visiveis = linhas.filter((l) => {
    if (termo !== "" && !l.marca.toLocaleUpperCase("pt-BR").includes(termo)) return false;
    if (filtro === "sem-regra") return l.governo === "NENHUMA";
    if (filtro === "propria") return l.governo === "MARCA" || l.governo === "ORFA";
    if (filtro === "padrao") return l.governo === "PADRAO";

    return true;
  });

  const FILTROS: { id: Filtro; rotulo: string }[] = [
    { id: "todas", rotulo: "Todas" },
    { id: "sem-regra", rotulo: "Sem regra" },
    { id: "propria", rotulo: "Regra própria" },
    { id: "padrao", rotulo: "Usam o padrão" },
  ];

  return (
    <>
      <div className="sb-cfg-filtros">
        <div className="sb-cfg-abas" role="group" aria-label="Filtrar marcas">
          {FILTROS.map((f) =>
            // "Usam o padrão" só existe quando há padrão; sem ele, a aba vazia é ruído.
            f.id === "padrao" && padrao === null ? null : (
              <button
                key={f.id}
                type="button"
                className={filtro === f.id ? "sb-button sb-button-sm sb-cfg-aba-ativa" : "sb-button sb-button-sm"}
                aria-pressed={filtro === f.id}
                onClick={() => {
                  setFiltro(f.id);
                }}
              >
                {f.rotulo} <span className="sb-cfg-aba-n">{contagem[f.id]}</span>
              </button>
            ),
          )}
        </div>

        <input
          className="sb-input sb-input-sm sb-cfg-busca"
          type="search"
          value={busca}
          placeholder="Buscar marca"
          aria-label="Buscar marca"
          onChange={(e) => {
            setBusca(e.target.value);
          }}
        />
      </div>

      {visiveis.length === 0 ? (
        <p className="sb-empty">
          Nenhuma marca neste recorte.{" "}
          <button
            type="button"
            className="sb-text-button"
            onClick={() => {
              setFiltro("todas");
              setBusca("");
            }}
          >
            Ver todas
          </button>
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="sb-table sb-cfg-tabela">
            <thead>
              <tr>
                <th>Marca</th>
                <th title="SKUs com saldo ou venda nos últimos 90 dias — o mesmo universo de /reposicao">Na reposição</th>
                <th>Situação</th>
                <th>Política aplicada</th>
                <th>
                  <span className="sb-sr-only">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visiveis.map((l) => {
                const participacao = totalNaReposicao > 0 ? (l.naReposicao / totalNaReposicao) * 100 : 0;
                const g = GOVERNO[l.governo];

                return (
                  <tr key={l.marca} className={l.governo === "NENHUMA" && l.comVenda30d > 0 ? "sb-cfg-linha-falta" : undefined}>
                    <td>
                      <span className="sb-cfg-marca">{l.marca}</span>
                      <small className="sb-cfg-sub">{formatCount(l.skus)} no cadastro</small>
                    </td>
                    <td>
                      {l.governo === "ORFA" ? (
                        <span className="sb-rep-mudo">—</span>
                      ) : (
                        <span className="sb-cfg-fatia" title={`${participacao.toFixed(1)}% dos SKUs da reposição`}>
                          <b>{formatCount(l.naReposicao)}</b>
                          <span className="sb-cfg-fatia-barra" aria-hidden="true">
                            <i style={{ width: `${Math.max(participacao, l.naReposicao > 0 ? 1.5 : 0).toFixed(1)}%` }} />
                          </span>
                          <small>{formatCount(l.comVenda30d)} com venda em 30d</small>
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="sb-status" style={TOM[g.tom]} title={g.dica}>
                        {g.rotulo}
                      </span>
                    </td>
                    <td>
                      {l.regra !== null ? (
                        politica(l.regra, false)
                      ) : l.governo === "PADRAO" && padrao !== null ? (
                        politica(padrao, true)
                      ) : (
                        <span className="sb-rep-mudo" title="sem política: a reposição recusa sugestão para esta marca">
                          —
                        </span>
                      )}
                    </td>
                    <td className="sb-cfg-acoes">
                      {podeEditar &&
                        (l.regra !== null ? (
                          <AbrirRegra
                            rotulo="Editar"
                            variante="texto"
                            regra={l.regra}
                            opcoes={opcoes}
                            padraoExiste={padrao !== null}
                            alcance={alcance}
                          />
                        ) : (
                          <AbrirRegra
                            rotulo={l.governo === "PADRAO" ? "Regra própria" : "Criar regra"}
                            variante="texto"
                            marcaInicial={l.marca}
                            opcoes={opcoes}
                            padraoExiste={padrao !== null}
                            alcance={alcance}
                          />
                        ))}
                      {l.governo !== "ORFA" && l.naReposicao > 0 && (
                        <Link
                          className="sb-text-button"
                          href={`/reposicao?marca=${encodeURIComponent(l.marca)}`}
                        >
                          Ver na reposição
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
