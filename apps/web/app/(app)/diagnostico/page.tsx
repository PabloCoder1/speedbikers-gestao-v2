import { diagnoseSalesAnomaly, estimateImpactBrl, shiftBusinessDate, toSalesMetricDate } from "@sb/domain";
import type { SalesAnomalyDiagnosis } from "@sb/domain";
import Link from "next/link";
import type { ReactNode } from "react";

import { CarregandoSeODemorar } from "../../../components/carregando-link";
import { FilterMenu } from "../../../components/filter-menu";
import { PageTitle } from "../../../components/page-title";
import { StatusPill } from "../../../components/status-pill";
import { EstadoDaTela, TENTAR_DE_NOVO } from "../../../components/estado-da-tela";
import {
  buildDiagnosticHref,
  filterByConfidence,
  resolveDiagnosticFilters,
  selectDiagnosis,
} from "../../../lib/diagnostic-filters";
import {
  lerBaselineDoDiagnostico,
  lerEvidenciasDoDiagnostico,
  lerPrecosMediosDoDiagnostico,
} from "../../../lib/diagnostico-leitura";
import { formatBusinessDate, formatCount, formatCurrency } from "../../../lib/format";
import { eventTypeLabel } from "../../../lib/labels";
import { createClient } from "../../../lib/supabase/server";
import { currentMembership } from "../../../lib/request-membership";
import { DiagnosisPanel } from "../skus/[skuId]/diagnosis-panel";

export const metadata = { title: "Diagnóstico — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio das demais telas.
export const dynamic = "force-dynamic";

/**
 * Primeira fatia da Fase 6 (Diagnóstico e Ações, `docs/ARCHITECTURE.md`
 * secao 16) — "Baseline, desvio e detecção estatística sem machine
 * learning" + "Correlação com domain_events datados" + "Contrato de
 * diagnóstico com evidências e confiança". "Central de Ações" (persistir o
 * diagnóstico como item acionável) e "Decisões com baseline_snapshot"
 * ficam para as próximas fatias da mesma fase — dependem desta existir
 * primeiro.
 *
 * `asOf` é ONTEM, não hoje — `daily_sku_metrics` de hoje ainda está
 * incompleto (mesmo raciocínio de `/vendas` sobre frescor de cálculo).
 * `get_sku_sales_baseline` faz toda a agregação em SQL (docs/ARCHITECTURE.md
 * secao 21); a interpretação (é anomalia? qual a causa?) é
 * `diagnoseSalesAnomaly`, pura, em `@sb/domain/diagnostics`.
 */

export default async function DiagnosticoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const supabase = await createClient();
  const filters = resolveDiagnosticFilters(await searchParams);

  const membership = await currentMembership();
  const organizationId = membership.organizationId;

  if (membership.error !== null) {
    // Distinto de "sem organização": aquela mensagem sugere problema de
    // cadastro; isto é falha de leitura transitória (D-067, Nível 3).
    return (
      <>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Diagnóstico</h1>
        <EstadoDaTela
          tipo="erro"
          titulo="Não foi possível confirmar sua organização."
          descricao="Sem a organização, o diagnóstico não sabe quais contas ler. Tente de novo em instantes."
          detalhe={membership.error.message}
          acao={{ href: "/diagnostico", rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
        />
      </>
    );
  }

  if (organizationId === null) {
    return (
      <>
        <PageTitle
          eyebrow="INTELIGÊNCIA / DETECÇÃO"
          title="Diagnóstico"
          subtitle="Da anomalia à ação recomendada, com evidências rastreáveis."
        />
        <p className="sb-empty">Sua conta não está associada a nenhuma organização.</p>
      </>
    );
  }

  const asOf = shiftBusinessDate(toSalesMetricDate(new Date()), -1);

  const { data: signals, error: baselineError } = await lerBaselineDoDiagnostico(
    supabase,
    organizationId,
    asOf,
  );

  // Primeira passada, sem eventos: só para achar QUAIS SKUs são anomalia,
  // evitando buscar domain_events de SKU nenhum sem necessidade.
  const candidateSkuIds = signals
    .filter(
      (row) =>
        diagnoseSalesAnomaly(
          organizationId,
          {
            skuId: row.sku_id,
            sku: row.sku,
            title: row.title,
            weekday: row.weekday,
            currentUnitsSold: row.current_units_sold,
            baselineMean: row.baseline_mean,
            baselineStddev: row.baseline_stddev,
            sampleCount: row.sample_count,
          },
          asOf,
          [],
        ) !== null,
    )
    .map((row) => row.sku_id);

  const { eventsBySku, openClaimsBySku, eventsError, claimsError } = await lerEvidenciasDoDiagnostico(
    supabase,
    organizationId,
    asOf,
    candidateSkuIds,
  );

  // Falha ao ler domain_events ficava invisível antes: o diagnóstico
  // reportava "nenhuma causa candidata encontrada" com confiança normal,
  // quando a causa real podia existir e só não foi lida (D-067).
  const error = baselineError ?? eventsError;

  const diagnoses: SalesAnomalyDiagnosis[] = [];

  for (const row of signals) {
    const diagnosis = diagnoseSalesAnomaly(
      organizationId,
      {
        skuId: row.sku_id,
        sku: row.sku,
        title: row.title,
        weekday: row.weekday,
        currentUnitsSold: row.current_units_sold,
        baselineMean: row.baseline_mean,
        baselineStddev: row.baseline_stddev,
        sampleCount: row.sample_count,
      },
      asOf,
      eventsBySku.get(row.sku_id) ?? [],
      { openClaims: openClaimsBySku.get(row.sku_id)?.size ?? 0 },
    );

    if (diagnosis !== null) {
      diagnoses.push(diagnosis);
    }
  }

  const skuLookup = new Map(signals.map((row) => [row.sku_id, row]));

  diagnoses.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));

  /*
    IMPACTO ESTIMADO — a terceira célula da grade do frame (D22).

    Preço médio só para os SKUs JÁ confirmados como anomalia, nunca para o
    catálogo inteiro: é a razão de `estimateImpactBrl` ser função separada de
    `diagnoseSalesAnomaly`, chamada depois. Sem anomalia, nenhuma leitura.

    `null` quando não há preço médio no período: **impacto desconhecido é
    diferente de impacto zero** (D-067), e a tela mostra "—".
  */
  const { precoPorSku, error: precosError } = await lerPrecosMediosDoDiagnostico(
    supabase,
    organizationId,
    asOf,
    diagnoses.map((d) => d.escopo.skuId),
  );
  const impactoPorSku = new Map<string, number | null>();

  for (const diagnosis of diagnoses) {
    impactoPorSku.set(
      diagnosis.escopo.skuId,
      estimateImpactBrl(diagnosis.unitsDelta, precoPorSku.get(diagnosis.escopo.skuId) ?? null),
    );
  }

  // O recorte de confiança age sobre diagnósticos JÁ calculados — mesmo
  // conjunto, sem leitura nova.
  const visiveis = filterByConfidence(diagnoses, filters.confidence);
  const selecionado = selectDiagnosis(visiveis, filters.selectedSkuId);

  const rotuloConfianca =
    filters.confidence === "alta"
      ? "Alta confiança"
      : filters.confidence === "media"
        ? "Confiança média"
        : "Todas as confianças";

  return (
    <>
      {/* `page-title` do frame, com a barra à direita. */}
      <PageTitle
        eyebrow="INTELIGÊNCIA / DETECÇÃO"
        title="Diagnóstico"
        subtitle="Da anomalia à ação recomendada, com evidências rastreáveis."
        aside={
          /*
            O frame põe DOIS menus aqui: "Todas as contas" e "Alta confiança".
            Só o segundo entrou. O diagnóstico é por SKU e
            `get_sku_sales_baseline` não recebe conta nem a conhece — um menu de
            conta seria um controle que não recorta nada.
          */
          <FilterMenu
            rotulo={rotuloConfianca}
            opcoes={[
              {
                href: buildDiagnosticHref(filters, { confidence: "todas", selectedSkuId: null }),
                label: "Todas as confianças",
                ativo: filters.confidence === "todas",
              },
              {
                href: buildDiagnosticHref(filters, { confidence: "alta", selectedSkuId: null }),
                label: "Alta confiança",
                ativo: filters.confidence === "alta",
              },
              {
                href: buildDiagnosticHref(filters, { confidence: "media", selectedSkuId: null }),
                label: "Confiança média",
                ativo: filters.confidence === "media",
              },
            ]}
          />
        }
      />

      <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>
        Venda de {formatBusinessDate(asOf)} comparada ao baseline do mesmo dia da semana (últimas 8 ocorrências,
        média ± desvio padrão). Sem machine learning — estatística e correlação com eventos registrados.{" "}
        <strong>{formatCount(visiveis.length)}</strong> anomalia(s) no recorte, entre {formatCount(signals.length)}{" "}
        SKU(s) com histórico suficiente.
      </p>

      {error !== null && (
        <EstadoDaTela
          tipo="erro"
          titulo="Não foi possível carregar o diagnóstico."
          descricao="Seus filtros foram preservados. Tente de novo; nada foi alterado."
          detalhe={error.message}
          acao={{ href: buildDiagnosticHref(filters, {}), rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
        />
      )}

      {/* D-468: a forma única do erro de leitura (D-502), no lugar do aviso provisório da T-R6. */}
      {error === null && (claimsError !== null || precosError !== null) && (
        <EstadoDaTela
          tipo="erro"
          titulo="Parte do diagnóstico não foi lida"
          descricao={[
            claimsError === null
              ? null
              : "As reclamações abertas ficaram de fora: o sinal de SAC não aparece, e isso não quer dizer que não haja reclamação.",
            precosError === null
              ? null
              : 'O preço médio ficou de fora: o impacto estimado aparece como "—" por isso, não por falta de venda.',
          ]
            .filter((parte): parte is string => parte !== null)
            .join(" ")}
          detalhe={[claimsError?.message, precosError?.message]
            .filter((mensagem): mensagem is string => mensagem !== undefined)
            .join("; ")}
          acao={{ href: buildDiagnosticHref(filters, {}), rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
        />
      )}

      {error === null && visiveis.length === 0 && (
        <p className="sb-empty">
          {diagnoses.length === 0
            ? "Nenhuma anomalia detectada — a venda do dia ficou dentro do baseline em todos os SKUs com histórico."
            : "Nenhuma anomalia com esta confiança."}
        </p>
      )}

      {error === null && selecionado !== null && (
        <div className="sb-split-layout">
          {/* MESTRE — a lista do frame, ordenada por |z| decrescente. */}
          <section className="sb-panel sb-diagnostic-list" aria-label="Anomalias detectadas">
            {visiveis.map((diagnosis) => {
              const linha = skuLookup.get(diagnosis.escopo.skuId);
              const impacto = impactoPorSku.get(diagnosis.escopo.skuId) ?? null;
              const causa = diagnosis.causasCandidatas[0];

              return (
                <Link
                  key={diagnosis.escopo.skuId}
                  className="sb-diagnostic-item"
                  href={buildDiagnosticHref(filters, { selectedSkuId: diagnosis.escopo.skuId })}
                  aria-current={diagnosis.escopo.skuId === selecionado.escopo.skuId ? "true" : undefined}
                >
                  <StatusPill
                    code={diagnosis.direcao === "queda" ? "FAILED" : "APPLIED"}
                    label={diagnosis.direcao === "queda" ? "Queda" : "Alta"}
                  />
                  <b>
                    {linha?.sku}
                    {/* O código cru do evento ("listing.price.changed") vira rótulo (lote 3). */}
                    {causa !== undefined ? ` · ${eventTypeLabel(causa.eventType)}` : ""}
                  </b>
                  <span>
                    Confiança {diagnosis.confianca === "alta" ? "Alta" : "Média"}
                    {/*
                      "—" quando não há preço médio: impacto DESCONHECIDO não é
                      impacto zero (D-067).
                    */}
                    <strong>{formatCurrency(impacto)}</strong>
                  </span>
                  <CarregandoSeODemorar />
                </Link>
              );
            })}
          </section>

          {/* DETALHE — o painel `.diagnosis` do frame. */}
          <section className="sb-panel sb-diagnosis" aria-label="Diagnóstico da anomalia selecionada">
            <div className="sb-panel-head">
              <div style={{ minWidth: 0 }}>
                <StatusPill
                  code={selecionado.direcao === "queda" ? "FAILED" : "APPLIED"}
                  label={selecionado.direcao === "queda" ? "Queda de venda" : "Alta de venda"}
                />
                <h2>
                  {skuLookup.get(selecionado.escopo.skuId)?.title ??
                    skuLookup.get(selecionado.escopo.skuId)?.sku}
                </h2>
                <p>
                  <span className="sb-mono">{skuLookup.get(selecionado.escopo.skuId)?.sku}</span> ·{" "}
                  {formatBusinessDate(asOf)}
                </p>
              </div>
            </div>

            <div className="sb-diagnosis-grid">
              <div>
                <span>Causa mais provável</span>
                {/*
                  Sem causa correlacionada a tela DIZ isso, em vez de repetir a
                  direção como se fosse explicação.
                */}
                <b>{selecionado.causasCandidatas[0]?.descricao ?? "Sem causa correlacionada"}</b>
              </div>
              <div>
                <span>Confiança</span>
                {/*
                  O frame mostra "Alta · 91%". O PERCENTUAL NÃO EXISTE:
                  `DiagnosisConfidence` tem dois valores, por limiar de z-score
                  (|z| >= 2 é anomalia, >= 3 sobe a confiança). Exibir 91% seria
                  número sintetizado sem definição catalogada (D-023). No lugar
                  dele a tela mostra o z-score, que é o insumo REAL da
                  classificação — mais honesto e mais útil.
                */}
                <b style={{ color: selecionado.confianca === "alta" ? "var(--sb-success)" : undefined }}>
                  {selecionado.confianca === "alta" ? "Alta" : "Média"}
                </b>
                <span style={{ fontFamily: "var(--sb-mono)" }}>z = {selecionado.zScore.toFixed(2)}</span>
              </div>
              <div>
                <span>Impacto estimado</span>
                <b>{formatCurrency(impactoPorSku.get(selecionado.escopo.skuId) ?? null)}</b>
                <span>
                  {selecionado.unitsDelta > 0 ? "+" : ""}
                  {formatCount(selecionado.unitsDelta)} un. × preço médio
                </span>
              </div>
            </div>

            <h3 style={{ margin: "var(--sb-space-3) 1.25rem 0.5rem", fontSize: "0.6875rem" }}>Evidências</h3>

            <ul className="sb-evidence">
              {selecionado.evidencias.map((evidencia) => (
                <li key={`${evidencia.tipo}-${evidencia.descricao}`}>
                  {/* A cor do marcador diz o TOM da evidência, não a ordem. */}
                  <i
                    className={
                      evidencia.tipo.includes("baseline") || evidencia.tipo.includes("desvio")
                        ? "sb-dot-violet"
                        : selecionado.direcao === "queda"
                          ? "sb-dot-danger"
                          : "sb-dot-success"
                    }
                  />
                  {evidencia.descricao}
                </li>
              ))}
            </ul>

            {selecionado.proximosPassos.length > 0 && (
              <>
                <h3 style={{ margin: "var(--sb-space-3) 1.25rem 0.5rem", fontSize: "0.6875rem" }}>
                  Próximos passos
                </h3>
                <ul className="sb-evidence">
                  {selecionado.proximosPassos.map((passo) => (
                    <li key={passo}>
                      <i className="sb-dot-violet" />
                      {passo}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {/*
              A "ANÁLISE DO COPILOTO" do frame. Não é texto novo: `DiagnosisPanel`
              já existe (aba Diagnóstico do SKU) e chama `/v1/copilot/query`,
              cujo prompt diz que ele NARRA um diagnóstico já calculado por um
              sistema determinístico separado. Sob demanda, nunca automática — a
              chamada custa, e a tela não a faz sem o operador pedir.
            */}
            <div className="sb-note sb-copilot-note">
              <span>✦ ANÁLISE DO COPILOTO</span>
              <DiagnosisPanel skuId={selecionado.escopo.skuId} embutido />
            </div>

            {/*
              As duas ações do frame ("Ver cobertura", "Criar pedido de compra"),
              como LINKS para as telas donas — esta tela é leitura, não escreve.
            */}
            <div className="sb-action-row">
              <Link className="sb-button" href={`/skus/${selecionado.escopo.skuId}`}>
                Ver o SKU
              </Link>
              {/* Abria um pedido EM BRANCO, até para queda de venda. A tela que
                  decide quanto comprar deste SKU é a reposição — o link leva a
                  ela já filtrada, e o pedido nasce de lá com a quantidade
                  sugerida (lote 3 do pente fino). */}
              <Link
                className="sb-button sb-button-primary"
                href={`/reposicao?busca=${encodeURIComponent(skuLookup.get(selecionado.escopo.skuId)?.sku ?? "")}`}
              >
                Ver reposição deste SKU
              </Link>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
