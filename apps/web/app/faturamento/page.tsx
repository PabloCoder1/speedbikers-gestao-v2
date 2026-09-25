import { previousBusinessDateRange, toSalesMetricDate } from "@sb/domain";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";

import { CarregandoBloco, CarregandoConteudo } from "../../components/carregando";
import { FilterMenu } from "../../components/filter-menu";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { formatBusinessDate } from "../../lib/format";
import { carregarLimites } from "../../lib/limites-central";
import { DEFAULT_PERIOD_DAYS, PERIOD_PRESETS, resolvePeriodRange, type PeriodRange } from "../../lib/period";
import { currentMembership } from "../../lib/request-membership";
import { createClient } from "../../lib/supabase/server";
import { CalculadoraPreco } from "./calculadora-preco";
import { CampanhasAds } from "./campanhas-ads";
import { AVISO, Numeros } from "./numeros";

export const metadata = { title: "Faturamento — Speed Bikers Gestão" };

// Sessão por cookie e RLS por quem está logado: nada aqui pode ser pré-renderizado.
export const dynamic = "force-dynamic";

/**
 * Faturamento (D-356) — quanto sobra de cada venda.
 *
 * `/vendas` responde "quanto vendemos"; esta tela responde "quanto ficou". A
 * conta é a do pedido do dono, e está em `docs/METRICS.md` 5F: recebido = preço
 * − comissão − frete; resultado = recebido − custo; margem = resultado ÷ preço.
 *
 * **Uma RPC, duas chamadas em paralelo.** `get_faturamento` devolve resumo,
 * série, contas e produtos numa passada sobre os mesmos pedidos; o período
 * anterior pede só o resumo (`p_detalhe = false`). Medido em produção como
 * usuário logado: ~510 ms para 30 dias com detalhe e ~375 ms sem, estáveis até a
 * oitava execução (sem a degradação do plano genérico de D-305).
 *
 * **A cobertura mora ao lado de cada número de margem.** Resultado e margem só
 * existem nos pedidos com frete observado, custo conhecido e um produto — e o
 * frete só é capturado desde 14/09/2026. Um período antigo mostra a receita e a
 * comissão inteiras e recusa a margem, em vez de inventá-la.
 *
 * Sem recorte de marca: o frete é do pedido e não se divide por marca (5E).
 */

type Consulta = Record<string, string | string[] | undefined>;

type Periodo = { days: number } | PeriodRange;

/** Mesmos parâmetros de `/vendas`: trocar de tela leva conta e período junto. */
function montarHref(base: "/faturamento" | "/vendas", periodo: Periodo, contaSlug: string | null): string {
  const search = new URLSearchParams();

  if ("from" in periodo) {
    search.set("from", periodo.from);
    search.set("to", periodo.to);
  } else if (periodo.days !== DEFAULT_PERIOD_DAYS) {
    search.set("days", String(periodo.days));
  }

  if (contaSlug !== null) {
    search.set("account", contaSlug);
  }

  const qs = search.toString();

  return qs === "" ? base : `${base}?${qs}`;
}

export default function FaturamentoPage(props: { searchParams: Promise<Consulta> }): ReactNode {
  return (
    <Shell>
      <Suspense fallback={<CarregandoConteudo rotulo="Carregando faturamento" />}>
        <FaturamentoContent {...props} />
      </Suspense>
    </Shell>
  );
}

async function FaturamentoContent({ searchParams }: { searchParams: Promise<Consulta> }): Promise<ReactNode> {
  const query = await searchParams;
  const supabase = await createClient();
  const today = toSalesMetricDate(new Date());

  const { range, days, invalidCustom } = resolvePeriodRange(query, today);
  const previousRange = previousBusinessDateRange(range.from, range.to);
  const isCustom = days === null;
  const periodo: Periodo = isCustom ? range : { days };

  // A conta da URL vira id aqui: as leituras abaixo dependem disto.
  const accountsResult = await supabase.from("ml_accounts").select("id, slug, label").order("label", { ascending: true });

  const accounts = accountsResult.data ?? [];
  const requestedSlug = typeof query.account === "string" ? query.account : null;
  const selectedAccount = accounts.find((account) => account.slug === requestedSlug) ?? null;
  const contaSlug = selectedAccount?.slug ?? null;
  const contaFiltro = selectedAccount === null ? {} : { p_ml_account_id: selectedAccount.id };

  // As duas em paralelo, e a página não espera por elas: o cabeçalho e os
  // filtros saem antes, e os números chegam por streaming.
  const leituras = Promise.all([
    supabase.rpc("get_faturamento", { p_date_from: range.from, p_date_to: range.to, ...contaFiltro }),
    supabase.rpc("get_faturamento", {
      p_date_from: previousRange.from,
      p_date_to: previousRange.to,
      ...contaFiltro,
      p_detalhe: false,
    }),
  ]);

  // Mercado Ads (D-363): leitura própria, em paralelo, com o mesmo recorte.
  const leituraAds = supabase.rpc("get_ads_overview", {
    p_date_from: range.from,
    p_date_to: range.to,
    ...(selectedAccount === null ? {} : { p_ml_account_id: selectedAccount.id }),
  });

  const contaLabel = selectedAccount === null ? "Todas as contas" : selectedAccount.label;
  const periodoLabel = isCustom ? "Período personalizado" : `Últimos ${String(days)} dias`;

  return (
    <>
      <PageTitle
        eyebrow="COMERCIAL / RESULTADOS"
        title="Faturamento"
        subtitle={
          <>
            {contaLabel}, {formatBusinessDate(range.from)} até {formatBusinessDate(range.to)} — comparado com{" "}
            {formatBusinessDate(previousRange.from)} até {formatBusinessDate(previousRange.to)}.
          </>
        }
        aside={
          <>
            {accountsResult.error === null && accounts.length > 0 && (
              <FilterMenu
                rotulo={contaLabel}
                opcoes={[
                  { href: montarHref("/faturamento", periodo, null), ativo: selectedAccount === null, label: "Todas as contas" },
                  ...accounts.map((account) => ({
                    href: montarHref("/faturamento", periodo, account.slug),
                    ativo: selectedAccount?.id === account.id,
                    label: account.label,
                  })),
                ]}
              />
            )}

            <FilterMenu
              rotulo={periodoLabel}
              opcoes={PERIOD_PRESETS.map((preset) => ({
                href: montarHref("/faturamento", { days: preset }, contaSlug),
                ativo: !isCustom && days === preset,
                label: `Últimos ${String(preset)} dias`,
              }))}
            >
              <form method="get" className="sb-periodo-form">
                {contaSlug !== null && <input type="hidden" name="account" value={contaSlug} />}
                <input
                  type="date"
                  name="from"
                  defaultValue={isCustom ? range.from : undefined}
                  aria-label="Data inicial"
                  className="sb-input"
                />
                <input
                  type="date"
                  name="to"
                  defaultValue={isCustom ? range.to : undefined}
                  aria-label="Data final"
                  className="sb-input"
                />
                <button type="submit" className="sb-button sb-button-primary">
                  Aplicar período
                </button>
              </form>
            </FilterMenu>

            <a className="sb-button" href="#ads">
              Campanhas (Ads)
            </a>

            <a className="sb-button sb-button-primary" href="#calculadora">
              Calculadora de preço
            </a>

            <Link className="sb-button" href={montarHref("/vendas", periodo, contaSlug)}>
              Dashboard de vendas
            </Link>
          </>
        }
      />

      {accountsResult.error !== null && (
        <p role="alert" style={AVISO}>
          Não foi possível carregar as contas: o filtro de conta está indisponível.
        </p>
      )}

      {invalidCustom && (
        <p role="alert" style={AVISO}>
          Período personalizado inválido — mostrando os últimos {DEFAULT_PERIOD_DAYS} dias.
        </p>
      )}

      <Suspense fallback={<CarregandoBloco rotulo="faturamento" />}>
        <Numeros leituras={leituras} range={range} todasAsContas={selectedAccount === null} />
      </Suspense>

      <section id="ads" className="sb-campanhas-ml" aria-label="Mercado Ads">
        <Suspense
          fallback={
            <Panel title="Mercado Ads — campanhas" subtitle="Carregando investimento e campanhas do período">
              <CarregandoBloco rotulo="campanhas do Mercado Ads" />
            </Panel>
          }
        >
          <CampanhasAds
            leitura={Promise.resolve(leituraAds)}
            periodo={`${formatBusinessDate(range.from)} até ${formatBusinessDate(range.to)}`}
          />
        </Suspense>
      </section>

      {/*
        A CALCULADORA DE PREÇO (D-359). Fora do Suspense dos números: ela não
        depende do período, e quem abre a tela só para simular não espera a
        leitura do faturamento.
      */}
      <Suspense fallback={null}>
        <CalculadoraComLimites contas={accounts.map((account) => ({ id: account.id, label: account.label }))} />
      </Suspense>
    </>
  );
}

/** A calculadora com a margem mínima da organização (D-410) -- uma leitura pequena, fora dos números. */
async function CalculadoraComLimites({ contas }: { contas: readonly { id: string; label: string }[] }): Promise<ReactNode> {
  const supabase = await createClient();
  const membership = await currentMembership();
  const limites = await carregarLimites(supabase, membership.organizationId);

  return <CalculadoraPreco contas={contas} margemMinima={limites.margemMinima} />;
}
