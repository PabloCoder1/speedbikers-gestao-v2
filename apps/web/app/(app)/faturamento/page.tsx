import { previousBusinessDateRange, toSalesMetricDate } from "@sb/domain";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";

import { CarregandoBloco, CarregandoConteudo } from "../../../components/carregando";
import { FilterMenu } from "../../../components/filter-menu";
import { EstadoDaTela, TENTAR_DE_NOVO } from "../../../components/estado-da-tela";
import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { SeletorDeMarketplace } from "../../../components/seletor-marketplace";
import { FormularioFiltro } from "../../../components/formulario-filtro";
import { hrefDeFaturamento } from "../../../lib/faturamento-multicanal";
import { formatBusinessDate } from "../../../lib/format";
import { carregarLimites } from "../../../lib/limites-central";
import { contarLojasShopee } from "../../../lib/marketplace";
import { DEFAULT_PERIOD_DAYS, PERIOD_PRESETS, resolvePeriodRange, type PeriodRange } from "../../../lib/period";
import { currentMembership } from "../../../lib/request-membership";
import { createClient } from "../../../lib/supabase/server";
import { resolverEscopoVendas } from "../../../lib/vendas-multicanal";
import { CalculadoraPreco } from "./calculadora-preco";
import { CampanhasAds } from "./campanhas-ads";
import { FaturamentoMulticanal } from "./multicanal";
import { Numeros } from "./numeros";

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
 *
 * **Shopee e "Todos" (D-442):** `marketplace=shopee` e `marketplace=todos` são
 * esta tela com outro recorte (`./multicanal.tsx`), lidos de outro contrato
 * (C-58). Sem `marketplace`, nada aqui muda — só o seletor no cabeçalho.
 */

type Consulta = Record<string, string | string[] | undefined>;

type Periodo = { days: number } | PeriodRange;

/** Mesmos parâmetros de `/vendas`: trocar de tela leva conta e período junto. */
function montarHref(base: "/faturamento" | "/vendas", periodo: Periodo, contaSlug: string | null): string {
  // Esta é a tela do ML: a /vendas do ML é `marketplace=ml` (sem ele, a /vendas abre em "Todos", D-488).
  const search = new URLSearchParams(base === "/vendas" ? { marketplace: "ml" } : {});

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
    <>
      <Suspense fallback={<CarregandoConteudo rotulo="Carregando faturamento" />}>
        <FaturamentoContent {...props} />
      </Suspense>
    </>
  );
}

async function FaturamentoContent({ searchParams }: { searchParams: Promise<Consulta> }): Promise<ReactNode> {
  const query = await searchParams;
  const escopo = resolverEscopoVendas(query.marketplace);

  if (escopo !== "ml") {
    return <FaturamentoMulticanal query={query} escopo={escopo} />;
  }

  const supabase = await createClient();
  const today = toSalesMetricDate(new Date());

  const { range, days, invalidCustom } = resolvePeriodRange(query, today);
  const previousRange = previousBusinessDateRange(range.from, range.to);
  const isCustom = days === null;
  const periodo: Periodo = isCustom ? range : { days };

  // A conta da URL vira id aqui: as leituras abaixo dependem disto. O número
  // de lojas Shopee (D-431) só decide se o seletor de marketplace aparece.
  const [accountsResult, lojasShopee] = await Promise.all([
    supabase.from("ml_accounts").select("id, slug, label").order("label", { ascending: true }),
    contarLojasShopee(supabase),
  ]);

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
            {/*
              O MARKETPLACE VEM PRIMEIRO (D-431). Para a Shopee e o "Todos" só o
              período atravessa: a conta daqui (`account=<slug>`) é do ML.
              Sem loja Shopee, o seletor não aparece.
            */}
            <SeletorDeMarketplace
              ativo="ml"
              contas={{ ml: accountsResult.error === null ? accounts.length : null, shopee: lojasShopee }}
              destinos={{
                ml: montarHref("/faturamento", periodo, contaSlug),
                todos: hrefDeFaturamento({ escopo: "ml", periodo, contas: null }, { escopo: "todos" }),
                shopee: hrefDeFaturamento({ escopo: "ml", periodo, contas: null }, { escopo: "shopee" }),
              }}
            />

            {accountsResult.error === null && accounts.length > 0 && (
              <FilterMenu
                nome="Conta"
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
              nome="Período"
              rotulo={periodoLabel}
              opcoes={PERIOD_PRESETS.map((preset) => ({
                href: montarHref("/faturamento", { days: preset }, contaSlug),
                ativo: !isCustom && days === preset,
                label: `Últimos ${String(preset)} dias`,
              }))}
            >
              <FormularioFiltro action="/faturamento" className="sb-periodo-form">
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
              </FormularioFiltro>
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

      {/* D-470: a forma única do erro de leitura (D-502). */}
      {accountsResult.error !== null && (
        <EstadoDaTela
          tipo="erro"
          titulo="Não foi possível carregar as contas"
          descricao="O filtro de conta está indisponível."
          detalhe={accountsResult.error.message}
          acao={{ href: montarHref("/faturamento", periodo, contaSlug), rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
        />
      )}

      {invalidCustom && (
        <p role="status" className="sb-note sb-note-atencao" style={{ margin: "0 0 var(--sb-space-3)" }}>
          Período personalizado inválido — mostrando os últimos {DEFAULT_PERIOD_DAYS} dias.
        </p>
      )}

      <Suspense fallback={<CarregandoBloco rotulo="faturamento" />}>
        <Numeros
          leituras={leituras}
          range={range}
          todasAsContas={selectedAccount === null}
          tentarDeNovo={montarHref("/faturamento", periodo, contaSlug)}
          limparFiltros={contaSlug === null ? null : montarHref("/faturamento", periodo, null)}
        />
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
            tentarDeNovo={montarHref("/faturamento", periodo, contaSlug)}
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
