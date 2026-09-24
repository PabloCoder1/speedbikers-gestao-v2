import { toSalesMetricDate } from "@sb/domain";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";

import { CarregandoBloco, CarregandoConteudo } from "../../components/carregando";
import { FilterMenu } from "../../components/filter-menu";
import { PageTitle } from "../../components/page-title";
import { Shell } from "../../components/shell";
import { PRESETS_CENTRAL, resolverPeriodoCentral, type PeriodoCentral } from "../../lib/central-periodo";
import { formatBusinessDate } from "../../lib/format";
import { carregarLimites } from "../../lib/limites-central";
import { currentMembership } from "../../lib/request-membership";
import { createClient } from "../../lib/supabase/server";
import { AVISO } from "../faturamento/numeros";
import { Atencao } from "./atencao";
import { Indicadores } from "./indicadores";
import { SinalDeAds } from "./sinal-ads";
import { SinalDoFrete } from "./sinal-frete";

export const metadata = { title: "Central do negócio — Speed Bikers Gestão" };

// Sessão por cookie e RLS por quem está logado: nada aqui pode ser pré-renderizado.
export const dynamic = "force-dynamic";

/**
 * Central do negócio (D-394) — o período em números, comparado com o anterior,
 * e o que mudou dito em texto.
 *
 * **Primeira fatia da central de inteligência** pedida pelo dono em 23/09: os
 * indicadores com comparação e tom, os períodos do negócio (hoje, ontem, mês
 * atual, mês anterior) e o resumo automático. A segunda (D-395) trouxe a meta
 * do mês com a projeção de fechamento e o imposto, com o lucro após imposto e
 * Ads. A terceira (D-397), o detector de frete, entra aqui como um painel com
 * os anúncios que pedem revisão; a quarta (D-398), os sinais de Ads por
 * campanha, como outro. A quinta (D-400) abre a página com a central de
 * alertas, "o que precisa da sua atenção", juntando os sinais de todas.
 *
 * **As mesmas consultas de `/faturamento`.** `get_faturamento` e
 * `get_ads_overview`, sem detalhe, para o período atual e o anterior, mais
 * `get_meta_do_mes` — cinco leituras em paralelo. Os números batem com a tela de
 * faturamento por construção; o que esta tela acrescenta é a comparação, com
 * as regras de `docs/METRICS.md` 5I.
 */

type Consulta = Record<string, string | string[] | undefined>;

function montarHref(periodo: { preset: string } | { from: string; to: string } | null, contaSlug: string | null): string {
  const search = new URLSearchParams();

  if (periodo !== null && "preset" in periodo) search.set("p", periodo.preset);
  if (periodo !== null && "from" in periodo) {
    search.set("from", periodo.from);
    search.set("to", periodo.to);
  }
  if (contaSlug !== null) search.set("account", contaSlug);

  const qs = search.toString();

  return qs === "" ? "/central" : `/central?${qs}`;
}

/** O mesmo período e a mesma conta no ranking de produtos (D-402). */
function hrefDoRanking(periodo: { preset: string } | { from: string; to: string }, contaSlug: string | null): string {
  return montarHref(periodo, contaSlug).replace("/central", "/central/produtos");
}

function periodoDaUrl(periodo: PeriodoCentral): { preset: string } | { from: string; to: string } {
  return periodo.preset === null ? periodo.atual : { preset: periodo.preset };
}

function intervalo(range: { from: string; to: string }): string {
  return range.from === range.to
    ? formatBusinessDate(range.from)
    : `${formatBusinessDate(range.from)} a ${formatBusinessDate(range.to)}`;
}

export default function CentralPage(props: { searchParams: Promise<Consulta> }): ReactNode {
  return (
    <Shell>
      <Suspense fallback={<CarregandoConteudo rotulo="Carregando a central" />}>
        <CentralContent {...props} />
      </Suspense>
    </Shell>
  );
}

async function CentralContent({ searchParams }: { searchParams: Promise<Consulta> }): Promise<ReactNode> {
  const query = await searchParams;
  const supabase = await createClient();
  const hoje = toSalesMetricDate(new Date());
  const periodo = resolverPeriodoCentral(query, hoje);

  const accountsResult = await supabase.from("ml_accounts").select("id, slug, label").order("label", { ascending: true });
  const accounts = accountsResult.data ?? [];
  const requestedSlug = typeof query.account === "string" ? query.account : null;
  const selectedAccount = accounts.find((account) => account.slug === requestedSlug) ?? null;
  const contaSlug = selectedAccount?.slug ?? null;
  const contaFiltro = selectedAccount === null ? {} : { p_ml_account_id: selectedAccount.id };

  // As quatro em paralelo, e a página não espera por elas: cabeçalho e filtros
  // saem antes, e os números chegam por streaming.
  const leituras = Promise.all([
    supabase.rpc("get_faturamento", {
      p_date_from: periodo.atual.from,
      p_date_to: periodo.atual.to,
      ...contaFiltro,
      p_detalhe: false,
    }),
    supabase.rpc("get_faturamento", {
      p_date_from: periodo.anterior.from,
      p_date_to: periodo.anterior.to,
      ...contaFiltro,
      p_detalhe: false,
    }),
    supabase.rpc("get_ads_overview", { p_date_from: periodo.atual.from, p_date_to: periodo.atual.to, ...contaFiltro }),
    supabase.rpc("get_ads_overview", { p_date_from: periodo.anterior.from, p_date_to: periodo.anterior.to, ...contaFiltro }),
  ]);

  // A meta é da organização e do mês corrente: não depende do período nem da conta.
  const membership = await currentMembership();
  const leituraMeta =
    membership.organizationId === null
      ? null
      : Promise.resolve(supabase.rpc("get_meta_do_mes", { p_organization_id: membership.organizationId }));
  const podeEditar = membership.role === "ADMIN" || membership.role === "GESTOR";
  // D-408: os limites que julgam os números, da organização. Nunca rejeita:
  // sem linha ou com erro, os padrões.
  const leituraLimites = carregarLimites(supabase, membership.organizationId);

  // O detector de frete é da organização e dos últimos 14 dias: não depende do
  // período nem da conta. Sai junto com as outras leituras e chega sozinho.
  const leituraFrete =
    membership.organizationId === null
      ? null
      : Promise.resolve(supabase.rpc("get_detector_frete", { p_organization_id: membership.organizationId }));
  // D-400: o faturamento do período COM detalhe só conta produtos com margem
  // negativa para a central de alertas. Leitura separada e em paralelo: os
  // indicadores não esperam pelo detalhe (~0,9 s contra ~0,4 s sem ele).
  const leituraProdutos = Promise.resolve(
    supabase.rpc("get_faturamento", {
      p_date_from: periodo.atual.from,
      p_date_to: periodo.atual.to,
      ...contaFiltro,
      p_detalhe: true,
    }),
  );

  // Os sinais de Ads usam a semana que o Mercado Livre já consolidou, não o período da central.
  const leituraAds =
    membership.organizationId === null
      ? null
      : Promise.resolve(supabase.rpc("get_sinais_ads", { p_organization_id: membership.organizationId }));

  const contaLabel = selectedAccount === null ? "Todas as contas" : selectedAccount.label;
  const periodoAtual = periodoDaUrl(periodo);
  const diasCompletos = periodo.preset === "7d" || periodo.preset === "15d" || periodo.preset === "30d" || (periodo.preset === "mes" && !periodo.emAndamento);

  return (
    <>
      <PageTitle
        eyebrow="COMERCIAL / CENTRAL"
        title="Central do negócio"
        subtitle={
          <>
            {contaLabel} · {periodo.rotulo}: {intervalo(periodo.atual)}, comparado com {intervalo(periodo.anterior)}.
            {diasCompletos && " Dias completos, até ontem."}
            {periodo.emAndamento && " Hoje ainda está em andamento."}
          </>
        }
        aside={
          <>
            {accountsResult.error === null && accounts.length > 0 && (
              <FilterMenu
                rotulo={contaLabel}
                opcoes={[
                  { href: montarHref(periodoAtual, null), ativo: selectedAccount === null, label: "Todas as contas" },
                  ...accounts.map((account) => ({
                    href: montarHref(periodoAtual, account.slug),
                    ativo: selectedAccount?.id === account.id,
                    label: account.label,
                  })),
                ]}
              />
            )}

            <FilterMenu
              rotulo={periodo.rotulo}
              opcoes={PRESETS_CENTRAL.map((preset) => ({
                href: montarHref({ preset: preset.id }, contaSlug),
                ativo: periodo.preset === preset.id,
                label: preset.label,
              }))}
            >
              <form method="get" className="sb-periodo-form">
                {contaSlug !== null && <input type="hidden" name="account" value={contaSlug} />}
                <input
                  type="date"
                  name="from"
                  defaultValue={periodo.preset === null ? periodo.atual.from : undefined}
                  aria-label="Data inicial"
                  className="sb-input"
                />
                <input
                  type="date"
                  name="to"
                  defaultValue={periodo.preset === null ? periodo.atual.to : undefined}
                  aria-label="Data final"
                  className="sb-input"
                />
                <button type="submit" className="sb-button sb-button-primary">
                  Aplicar período
                </button>
              </form>
            </FilterMenu>

            <Link className="sb-button" href="/central/metas">
              Metas e imposto
            </Link>

            <Link className="sb-button" href="/central/limites">
              Limites
            </Link>

            <Link className="sb-button" href="/central/frete">
              Detector de frete
            </Link>

            <Link className="sb-button" href="/central/ads">
              Sinais de Ads
            </Link>

            <Link className="sb-button" href={hrefDoRanking(periodoAtual, contaSlug)}>
              Ranking de produtos
            </Link>

            <Link className="sb-button" href={contaSlug === null ? "/faturamento" : `/faturamento?account=${encodeURIComponent(contaSlug)}`}>
              Faturamento detalhado
            </Link>
          </>
        }
      />

      {accountsResult.error !== null && (
        <p role="alert" style={AVISO}>
          Não foi possível carregar as contas: o filtro de conta está indisponível.
        </p>
      )}

      {periodo.invalido && (
        <p role="alert" style={AVISO}>
          Período personalizado inválido — mostrando {periodo.rotulo.toLowerCase()}.
        </p>
      )}

      <Suspense fallback={<CarregandoBloco rotulo="o que precisa da sua atenção" />}>
        <Atencao
          leituras={leituras}
          leituraMeta={leituraMeta}
          leituraFrete={leituraFrete}
          leituraAds={leituraAds}
          leituraProdutos={leituraProdutos}
          leituraLimites={leituraLimites}
          periodo={periodo}
          hrefRanking={hrefDoRanking(periodoAtual, contaSlug)}
        />
      </Suspense>

      <Suspense fallback={<CarregandoBloco rotulo="indicadores do período" />}>
        <Indicadores
          leituras={leituras}
          leituraMeta={leituraMeta}
          leituraLimites={leituraLimites}
          periodo={periodo}
          podeEditar={podeEditar}
        />
      </Suspense>

      <Suspense fallback={<CarregandoBloco rotulo="detector de frete" />}>
        <SinalDoFrete leitura={leituraFrete} />
      </Suspense>

      <Suspense fallback={<CarregandoBloco rotulo="sinais de Ads" />}>
        <SinalDeAds leitura={leituraAds} />
      </Suspense>
    </>
  );
}
