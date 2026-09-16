import { toSalesMetricDate } from "@sb/domain";
import Link from "next/link";
import type { ReactNode } from "react";

import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { Shell } from "../../../components/shell";
import { formatCount, formatDateTime } from "../../../lib/format";
import {
  calcularAlcance,
  governadosPelaRegra,
  lerGruposDoAlcance,
  type Alcance,
  type GrupoDoAlcance,
} from "../../../lib/replenishment-reach";
import { fraseDaRegra } from "../../../lib/replenishment-rule";
import { currentMembership } from "../../../lib/request-membership";
import { createClient } from "../../../lib/supabase/server";

import { AvisoDaConfiguracao } from "./aviso";
import { AbrirRegra, type OpcaoDeEscopo, type RegraExistente } from "./gaveta-regra";
import { ListaDeMarcas, type LinhaDeMarca } from "./lista-marcas";
import { ReguaPolitica } from "./regua-politica";

export const metadata = { title: "Configuração de reposição — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio das demais telas.
export const dynamic = "force-dynamic";

/**
 * Configuração de reposição (D-144, a fundação da Fase 5D; refeita em D-361).
 *
 * Três escopos, o mais específico vence: SKU > marca do fornecedor > padrão da
 * organização. **Zero linhas semeadas**: configurar é ato humano (D-127/D-133),
 * e enquanto não houver regra aplicável a sugestão de compra RECUSA número em
 * vez de inventar default.
 *
 * ## D-361: a tela responde "quanto do catálogo isto destrava?"
 *
 * Era uma tabela de regras com quatro campos soltos por linha. Com zero regras
 * — produção, no dia desta fatia: 1.650 SKUs na reposição, 17 marcas, nenhuma
 * regra — ela mostrava uma frase e um formulário horizontal, e nada dizia que o
 * catálogo INTEIRO estava sem sugestão, nem por onde começar.
 *
 * Agora, de cima para baixo, na ordem das perguntas:
 *
 * 1. **quanto está coberto** — o resumo, com os mesmos cartões de `/reposicao`;
 * 2. **por onde começar** — sem regra nenhuma, o caminho é o padrão da
 *    organização, que cobre tudo de uma vez;
 * 3. **o padrão** — os números, a régua nos tons dos estados e a frase de
 *    operação;
 * 4. **cada marca** — quem a governa hoje (regra própria, padrão ou nada), em
 *    ordem de quem mais destrava;
 * 5. **exceções por SKU**, só quando existem.
 *
 * O alcance vem de `get_replenishment_reach` (só conta, no mesmo universo de
 * `get_purchase_suggestions`) cruzado com as regras por `calcularAlcance`. Se a
 * leitura falhar — o Preview do PR roda contra o Dev antes da migration —, a
 * tela continua configurável, só sem os números de alcance.
 */

function regraDaLinha(linha: {
  id: string;
  supplier_brand: string | null;
  sku_id: string | null;
  lead_time_days: number;
  target_coverage_days: number;
  safety_stock_days: number;
  max_coverage_days: number | null;
  policy_note: string | null;
  skus: { sku: string } | null;
}): RegraExistente {
  return {
    id: linha.id,
    marca: linha.supplier_brand,
    skuId: linha.sku_id,
    skuCodigo: linha.skus?.sku ?? null,
    prazo: linha.lead_time_days,
    cobertura: linha.target_coverage_days,
    seguranca: linha.safety_stock_days,
    teto: linha.max_coverage_days,
    nota: linha.policy_note,
  };
}

function pct(parte: number, todo: number): number {
  return todo > 0 ? Math.floor((parte / todo) * 100) : 0;
}

function Numero({ rotulo, valor, dica }: { rotulo: string; valor: string; dica: string }): ReactNode {
  return (
    <div className="sb-cfg-numero">
      <span>{rotulo}</span>
      <strong>{valor}</strong>
      <small>{dica}</small>
    </div>
  );
}

export default async function ReposicaoConfigPage(): Promise<ReactNode> {
  const supabase = await createClient();
  const membership = await currentMembership();
  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <Shell>
        <PageTitle eyebrow="ESTOQUE / PLANEJAMENTO" title="Configuração de reposição" compacto />
        <p className="sb-empty">Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const podeEditar = membership.role === "ADMIN" || membership.role === "GESTOR";

  // Três leituras numa ida (D-185). As marcas só servem se o alcance falhar,
  // mas são 17 textos: esperar a falha para pedi-las custaria uma segunda ida.
  const [settingsResult, reachResult, brandsResult] = await Promise.all([
    supabase
      .from("replenishment_settings")
      .select(
        "id, supplier_brand, sku_id, lead_time_days, target_coverage_days, safety_stock_days, max_coverage_days, policy_note, updated_at, skus(sku)",
      )
      .order("supplier_brand", { ascending: true, nullsFirst: true }),
    supabase.rpc("get_replenishment_reach", {
      p_organization_id: organizationId,
      p_date_to: toSalesMetricDate(new Date()),
    }),
    supabase.rpc("get_supplier_brands", { p_organization_id: organizationId }),
  ]);

  if (settingsResult.error !== null) {
    return (
      <Shell>
        <PageTitle eyebrow="ESTOQUE / PLANEJAMENTO" title="Configuração de reposição" compacto />
        <p role="alert" className="sb-note sb-note-perigo">
          Não foi possível carregar as regras de reposição: {settingsResult.error.message}
        </p>
      </Shell>
    );
  }

  const linhasDeRegra = settingsResult.data;
  const regras = linhasDeRegra.map(regraDaLinha);
  const atualizadoEm = new Map(linhasDeRegra.map((l) => [l.id, l.updated_at]));

  const padrao = regras.find((r) => r.marca === null && r.skuId === null) ?? null;
  const regrasDeMarca = new Map(regras.flatMap((r) => (r.marca === null ? [] : [[r.marca, r] as const])));
  const regrasDeSku = regras.filter((r) => r.skuId !== null);

  const grupos: GrupoDoAlcance[] =
    reachResult.error === null
      ? lerGruposDoAlcance(reachResult.data)
      : (brandsResult.data ?? []).map((b) => ({
          marca: b.supplier_brand,
          skus: 0,
          naReposicao: 0,
          comVenda30d: 0,
          comRegraSku: 0,
          comRegraSkuVenda30d: 0,
        }));

  const alcance: Alcance | null =
    reachResult.error === null
      ? calcularAlcance(grupos, regras.map((r) => ({ id: r.id, marca: r.marca, skuId: r.skuId })))
      : null;

  // Sem alcance, a ordem é alfabética e o governo sai só das regras. O
  // `flatMap` descarta o grupo sem marca E estreita o tipo de `marca`.
  const marcasOrdenadas = (alcance?.marcas ?? grupos).flatMap((g) => (g.marca === null ? [] : [{ ...g, marca: g.marca }]));

  const linhas: LinhaDeMarca[] = [
    ...marcasOrdenadas.map((g) => {
      const regra = regrasDeMarca.get(g.marca) ?? null;

      return {
        marca: g.marca,
        skus: g.skus,
        naReposicao: g.naReposicao,
        comVenda30d: g.comVenda30d,
        governo: regra !== null ? ("MARCA" as const) : padrao !== null ? ("PADRAO" as const) : ("NENHUMA" as const),
        regra,
      };
    }),
    ...(alcance?.regrasOrfas ?? []).map((marca) => ({
      marca,
      skus: 0,
      naReposicao: 0,
      comVenda30d: 0,
      governo: "ORFA" as const,
      regra: regrasDeMarca.get(marca) ?? null,
    })),
  ];

  const opcoes: OpcaoDeEscopo[] = marcasOrdenadas.map((g) => ({
    marca: g.marca,
    naReposicao: g.naReposicao,
    comVenda30d: g.comVenda30d,
    temRegra: regrasDeMarca.has(g.marca),
  }));

  const totais = alcance?.totais ?? null;
  const cobertura = totais === null ? 0 : pct(totais.cobertos, totais.naReposicao);
  const vendendoSemRegra = totais === null ? 0 : totais.comVenda30d - totais.cobertosComVenda;
  const temMarcaSemRegra = opcoes.some((o) => !o.temRegra);

  const padraoGoverna = alcance === null || padrao === null ? null : governadosPelaRegra(alcance, { tipo: "PADRAO" });

  return (
    <Shell>
      <PageTitle
        eyebrow="ESTOQUE / PLANEJAMENTO"
        title="Configuração de reposição"
        subtitle="Quanto tempo o fornecedor leva e quantos dias de venda cada compra deve cobrir — a base de toda sugestão de compra."
        aside={
          <>
            <Link className="sb-button" href="/reposicao">
              ← Cobertura e reposição
            </Link>
            {podeEditar && regras.length > 0 && (padrao === null || temMarcaSemRegra) && (
              <AbrirRegra
                rotulo="Nova regra"
                variante="primario"
                marcaInicial={padrao === null ? "" : (opcoes.find((o) => !o.temRegra)?.marca ?? "")}
                opcoes={opcoes}
                padraoExiste={padrao !== null}
                alcance={alcance}
              />
            )}
          </>
        }
      />

      <AvisoDaConfiguracao />

      {reachResult.error !== null && (
        <p role="alert" className="sb-note sb-note-atencao sb-cfg-mensagem">
          O alcance das regras não pôde ser lido ({reachResult.error.message}). As regras continuam editáveis; os números
          de quantos SKUs cada uma cobre voltam quando a leitura voltar.
        </p>
      )}

      {totais !== null && (
        <section className="sb-rep-resumo" aria-label="Resumo da configuração">
          <div
            className={
              totais.cobertos === 0
                ? "sb-rep-destaque sb-rep-destaque-perigo"
                : cobertura === 100
                  ? "sb-rep-destaque sb-cfg-destaque-ok"
                  : "sb-rep-destaque"
            }
          >
            <span className="sb-rep-destaque-rotulo">SKUs com política</span>
            <strong>{cobertura}%</strong>
            <span className="sb-cfg-progresso" aria-hidden="true">
              <i style={{ width: `${String(cobertura)}%` }} />
            </span>
            <span className="sb-rep-destaque-nota">
              {formatCount(totais.cobertos)} de {formatCount(totais.naReposicao)} SKUs da reposição
            </span>
          </div>

          <div className={vendendoSemRegra > 0 ? "sb-rep-destaque" : "sb-rep-destaque sb-cfg-destaque-ok"}>
            <span className="sb-rep-destaque-rotulo">Com venda e sem política</span>
            <strong>{formatCount(vendendoSemRegra)}</strong>
            <span className="sb-rep-destaque-nota">
              {vendendoSemRegra > 0 ? (
                <>
                  SKUs vendendo nos últimos 30 dias que a reposição recusa hoje ·{" "}
                  <Link href="/reposicao?estado=SEM_ESTADO">ver na reposição</Link>
                </>
              ) : (
                "todo SKU com venda recente tem política"
              )}
            </span>
          </div>

          <div className={padrao === null ? "sb-rep-destaque" : "sb-rep-destaque sb-cfg-destaque-ok"}>
            <span className="sb-rep-destaque-rotulo">Padrão da organização</span>
            <strong>{padrao === null ? "Não definido" : `Janela ${String(padrao.prazo + padrao.seguranca + padrao.cobertura)}d`}</strong>
            <span className="sb-rep-destaque-nota">
              {padrao === null
                ? "sem ele, marca sem regra própria fica sem sugestão"
                : `vale para ${formatCount(padraoGoverna?.skus ?? 0)} SKUs sem regra própria`}
            </span>
          </div>

          <div className="sb-rep-destaque">
            <span className="sb-rep-destaque-rotulo">Marcas com regra própria</span>
            <strong>
              {formatCount(totais.marcasComRegra)} <small>de {formatCount(totais.marcasNaReposicao)}</small>
            </strong>
            <span className="sb-rep-destaque-nota">
              {totais.marcasNaReposicao - totais.marcasComRegra === 0
                ? "todas as marcas da reposição"
                : padrao === null
                  ? "as demais ficam sem política"
                  : "as demais seguem o padrão"}
            </span>
          </div>
        </section>
      )}

      {/*
        POR ONDE COMEÇAR. Sem regra nenhuma, a resposta prática é UMA: o padrão
        cobre o catálogo inteiro de uma vez, e as marcas que fogem dele vêm
        depois. A ordem inversa (marca por marca) deixaria 16 marcas descobertas
        até a última regra.
      */}
      {regras.length === 0 && (
        <section className="sb-cfg-comeco" aria-labelledby="cfg-comeco-titulo">
          <div>
            <span className="sb-rep-destaque-rotulo">Primeiros passos</span>
            <h2 id="cfg-comeco-titulo">
              {totais === null
                ? "Nenhuma regra ainda — a reposição recusa sugestão de compra"
                : `Nenhuma regra ainda — a reposição recusa sugestão para ${formatCount(totais.naReposicao)} SKUs`}
            </h2>
            <p>
              Comece pelo <b>padrão da organização</b>: uma regra só passa a valer para todo o catálogo
              {totais !== null && ` (${formatCount(totais.comVenda30d)} SKUs com venda nos últimos 30 dias)`}. Depois,
              crie regra própria só para as marcas que fogem dele — importação, prazos longos, fornecedor lento.
            </p>
            <ol className="sb-cfg-passos">
              <li>
                <b>1</b> Defina o padrão da organização
              </li>
              <li>
                <b>2</b> Ajuste as marcas que fogem dele
              </li>
              <li>
                <b>3</b> Confira as sugestões na reposição
              </li>
            </ol>
          </div>

          {podeEditar ? (
            <div className="sb-cfg-comeco-acoes">
              <AbrirRegra
                rotulo="Definir o padrão da organização"
                variante="primario"
                marcaInicial=""
                opcoes={opcoes}
                padraoExiste={false}
                alcance={alcance}
              />
              {opcoes.length > 0 && (
                <AbrirRegra
                  rotulo="Começar por uma marca"
                  variante="texto"
                  marcaInicial={opcoes[0]?.marca ?? ""}
                  opcoes={opcoes}
                  padraoExiste={false}
                  alcance={alcance}
                />
              )}
            </div>
          ) : (
            <p className="sb-cfg-leitura">Somente ADMIN e GESTOR criam regras. Peça a um deles para começar.</p>
          )}
        </section>
      )}

      {regras.length > 0 && (
        <Panel
          title="Padrão da organização"
          subtitle="Vale para toda marca sem regra própria — e é a única regra que alcança SKU sem marca."
          aside={
            podeEditar ? (
              padrao === null ? (
                <AbrirRegra
                  rotulo="Definir o padrão"
                  variante="primario"
                  marcaInicial=""
                  opcoes={opcoes}
                  padraoExiste={false}
                  alcance={alcance}
                />
              ) : (
                <AbrirRegra rotulo="Editar padrão" regra={padrao} opcoes={opcoes} padraoExiste alcance={alcance} />
              )
            ) : undefined
          }
        >
          {padrao === null ? (
            <p className="sb-cfg-sem-padrao">
              <b>Sem padrão definido.</b>{" "}
              {totais === null
                ? "Marcas sem regra própria ficam sem sugestão de compra."
                : `${formatCount(totais.naReposicao - totais.cobertos)} SKUs de marcas sem regra própria ficam sem sugestão de compra (${formatCount(vendendoSemRegra)} com venda recente).`}
            </p>
          ) : (
            <div className="sb-cfg-padrao">
              <div className="sb-cfg-numeros">
                <Numero rotulo="Prazo do fornecedor" valor={`${String(padrao.prazo)}d`} dica="do pedido à chegada" />
                <Numero rotulo="Segurança" valor={`${String(padrao.seguranca)}d`} dica="margem para atraso" />
                <Numero rotulo="Cobertura desejada" valor={`${String(padrao.cobertura)}d`} dica="depois de chegar" />
                <Numero
                  rotulo="Teto"
                  valor={padrao.teto === null ? "—" : `${String(padrao.teto)}d`}
                  dica={padrao.teto === null ? "excesso não apontado" : "acima é excesso"}
                />
              </div>

              <ReguaPolitica prazo={padrao.prazo} cobertura={padrao.cobertura} seguranca={padrao.seguranca} teto={padrao.teto} />

              <p className="sb-cfg-frase">{fraseDaRegra(padrao)}</p>

              <p className="sb-cfg-rodape-regra">
                {padraoGoverna !== null && (
                  <>
                    Governa <b>{formatCount(padraoGoverna.skus)} SKUs</b> ({formatCount(padraoGoverna.comVenda)} com venda
                    recente) ·{" "}
                  </>
                )}
                {padrao.nota !== null && <>“{padrao.nota}” · </>}
                atualizado em {formatDateTime(atualizadoEm.get(padrao.id) ?? null)}
              </p>
            </div>
          )}
        </Panel>
      )}

      <div className="sb-cfg-bloco">
        <Panel
          title="Regras por marca"
          subtitle="A regra da marca vence o padrão. Em ordem de quem mais destrava: venda recente primeiro."
        >
          {linhas.length === 0 ? (
            <p className="sb-empty">Nenhuma marca no catálogo ainda — a marca do fornecedor vem do cadastro de SKU.</p>
          ) : (
            <ListaDeMarcas
              linhas={linhas}
              padrao={padrao}
              totalNaReposicao={totais?.naReposicao ?? 0}
              opcoes={opcoes}
              alcance={alcance}
              podeEditar={podeEditar}
            />
          )}

          {alcance !== null && alcance.semMarca !== null && alcance.semMarca.naReposicao > 0 && (
            <p className="sb-cfg-sem-marca">
              <b>{formatCount(alcance.semMarca.naReposicao)} SKUs sem marca</b> na reposição
              {padrao === null ? " ficam sem política: só o padrão da organização os alcança." : " seguem o padrão da organização."}
            </p>
          )}
        </Panel>
      </div>

      {regrasDeSku.length > 0 && (
        <div className="sb-cfg-bloco">
          <Panel title="Exceções por SKU" subtitle="Um SKU com regra própria ignora a regra da marca e o padrão.">
            <div style={{ overflowX: "auto" }}>
              <table className="sb-table sb-cfg-tabela">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Política</th>
                    <th>Nota</th>
                    <th>
                      <span className="sb-sr-only">Ações</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {regrasDeSku.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link className="sb-rep-sku" href={`/skus/${r.skuId ?? ""}`}>
                          {r.skuCodigo ?? r.skuId}
                        </Link>
                      </td>
                      <td>
                        <div className="sb-cfg-politica">
                          <span className="sb-cfg-politica-numeros">
                            {r.prazo}d prazo · {r.seguranca}d seg. · {r.cobertura}d cob.
                            {r.teto !== null && ` · teto ${String(r.teto)}d`}
                          </span>
                          <ReguaPolitica prazo={r.prazo} cobertura={r.cobertura} seguranca={r.seguranca} teto={r.teto} compacta />
                        </div>
                      </td>
                      <td className="sb-cfg-sub">{r.nota ?? "—"}</td>
                      <td className="sb-cfg-acoes">
                        {podeEditar && (
                          <AbrirRegra
                            rotulo="Editar"
                            variante="texto"
                            regra={r}
                            opcoes={opcoes}
                            padraoExiste={padrao !== null}
                            alcance={alcance}
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      )}

      <details className="sb-rep-metodo sb-cfg-bloco">
        <summary>Como a regra vira sugestão de compra</summary>
        <div>
          <p>
            <b>Janela = prazo + segurança + cobertura.</b> A compra precisa cobrir o tempo até chegar <em>mais</em> os
            dias de venda depois de chegar — prazo não substitui cobertura: comprar 15 dias de estoque com 15 dias de
            prazo zera antes da entrega.
          </p>
          <p>
            <b>Sugestão = venda/dia dos últimos 30 dias × janela − estoque aproveitável</b> (local + Full + trânsito, com
            o reservado fora). O <b>estado</b> compara a cobertura em dias com a régua: até o prazo, compra urgente; até
            o ponto de pedido, comprar em breve; abaixo da janela, cobertura baixa; acima do teto, excesso.
          </p>
          <p>
            <b>O mais específico vence:</b> regra do SKU, depois a da marca, depois o padrão. SKU sem marca só usa o
            padrão. Sem nenhuma regra aplicável, a reposição recusa a sugestão em vez de inventar número — e mesmo com
            regra ela recusa quando falta estoque real, histórico ou amostra de venda.
          </p>
        </div>
      </details>

      {!podeEditar && regras.length > 0 && (
        <p className="sb-cfg-leitura">Somente ADMIN e GESTOR alteram a configuração de reposição.</p>
      )}
    </Shell>
  );
}
