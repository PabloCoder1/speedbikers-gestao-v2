import { toSalesMetricDate } from "@sb/domain";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";

import { CarregandoBloco, CarregandoConteudo } from "../../../components/carregando";
import { FormularioFiltro } from "../../../components/formulario-filtro";
import { CorpoTodos } from "../faturamento/multicanal";
import { FilterMenu } from "../../../components/filter-menu";
import {
  escreverPeriodoNaUrl,
  periodoDaUrl,
  PRESETS_CENTRAL,
  resolverPeriodoCentral,
  rotuloDoIntervalo,
  type PeriodoNaUrl,
} from "../../../lib/central-periodo";
import { carregarLimites } from "../../../lib/limites-central";
import { currentMembership } from "../../../lib/request-membership";
import { createClient } from "../../../lib/supabase/server";
import { EstadoDaTela, TENTAR_DE_NOVO } from "../../../components/estado-da-tela";
import { Atencao, AtencaoCarregando } from "./atencao";
import { AvisoDePeriodoInvalido, CabecalhoDaCentral } from "./comum";
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

function montarHref(periodo: PeriodoNaUrl | null, contaSlug: string | null): string {
  const search = new URLSearchParams();

  if (periodo !== null) escreverPeriodoNaUrl(search, periodo);
  if (contaSlug !== null) search.set("account", contaSlug);

  const qs = search.toString();

  return qs === "" ? "/central" : `/central?${qs}`;
}

/** O mesmo período e a mesma conta no ranking de produtos (D-402). */
function hrefDoRanking(periodo: PeriodoNaUrl, contaSlug: string | null): string {
  return montarHref(periodo, contaSlug).replace("/central", "/central/produtos");
}

export default function CentralPage(props: { searchParams: Promise<Consulta> }): ReactNode {
  return (
    <>
      <Suspense fallback={<CarregandoConteudo rotulo="Carregando a central" />}>
        <CentralContent {...props} />
      </Suspense>
    </>
  );
}

async function CentralContent({ searchParams }: { searchParams: Promise<Consulta> }): Promise<ReactNode> {
  const query = await searchParams;
  const supabase = await createClient();
  const hoje = toSalesMetricDate(new Date());
  const periodo = resolverPeriodoCentral(query, hoje);

  const requestedSlug = typeof query.account === "string" ? query.account : null;

  /*
    SEM FILA ATÉ AS LEITURAS DO PERÍODO (UX_SYSTEM §6, bloco 1). Elas esperavam a
    lista de contas, e as da organização esperavam as do período começarem. Agora
    contas e organização saem juntas, e as leituras do período só esperam as
    contas quando a URL escolhe uma (é delas que sai o id); sem conta, saem na
    hora. As mesmas leituras, com os mesmos argumentos.
  */
  const accountsPromise = Promise.resolve(supabase.from("ml_accounts").select("id, slug, label").order("label", { ascending: true }));
  const membershipPromise = currentMembership();
  const contaPromise =
    requestedSlug === null
      ? Promise.resolve(null)
      : accountsPromise.then((resultado) => (resultado.data ?? []).find((account) => account.slug === requestedSlug) ?? null);
  const filtroPromise = contaPromise.then((conta) => (conta === null ? {} : { p_ml_account_id: conta.id }));

  // As quatro em paralelo, e a página não espera por elas: cabeçalho e filtros
  // saem antes, e os números chegam por streaming.
  //
  // O PERÍODO ATUAL É LIDO UMA VEZ SÓ, COM DETALHE (UX_SYSTEM §6, bloco 1). A
  // central de alertas precisa do detalhe (os produtos com margem negativa,
  // D-400), e o `resumo` e a `margem_minima` são os mesmos com e sem ele
  // (conferido no banco, 19/10): os indicadores, os alertas e o "Por
  // marketplace" leem a mesma resposta. Medido em produção pelo A1, em 30 dias:
  // ~0,5 s sem detalhe e ~0,6 s com — uma `get_faturamento` a menos por carga
  // vale os ~0,1 s (os cancelamentos por tempo de 19/10 vinham das rajadas).
  const leituras = filtroPromise.then((contaFiltro) => Promise.all([
    supabase.rpc("get_faturamento", {
      p_date_from: periodo.atual.from,
      p_date_to: periodo.atual.to,
      ...contaFiltro,
      p_detalhe: true,
    }),
    supabase.rpc("get_faturamento", {
      p_date_from: periodo.anterior.from,
      p_date_to: periodo.anterior.to,
      ...contaFiltro,
      p_detalhe: false,
    }),
    supabase.rpc("get_ads_overview", { p_date_from: periodo.atual.from, p_date_to: periodo.atual.to, ...contaFiltro }),
    supabase.rpc("get_ads_overview", { p_date_from: periodo.anterior.from, p_date_to: periodo.anterior.to, ...contaFiltro }),
  ]));

  // D-400: os produtos com margem negativa da central de alertas saem da mesma
  // leitura do período atual, que já vem com detalhe.
  const leituraProdutos = leituras.then(([atual]) => atual);

  // Se as contas LANÇAREM (falha de rede, não `{ error }`), a página cai no
  // `await` abaixo antes de alguém esperar estas leituras: sem um dono, a
  // rejeição viraria `unhandledRejection` no log. Quem as consome ainda recebe a
  // falha (revisão do A2, D-517).
  void leituras.catch(() => undefined);
  void leituraProdutos.catch(() => undefined);

  const [accountsResult, membership, selectedAccount] = await Promise.all([accountsPromise, membershipPromise, contaPromise]);
  const accounts = accountsResult.data ?? [];
  const contaSlug = selectedAccount?.slug ?? null;

  // A meta é da organização e do mês corrente: não depende do período nem da conta.
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
      {/* As seis telas da Central e o recorte que viaja entre elas (UX_SYSTEM §6, bloco 1). */}
      {/* O período recusado (inválido) não viaja: as abas levam o recorte que a página aplicou. */}
      <CabecalhoDaCentral
        tela="central"
        consulta={{ ...(periodo.invalido ? {} : query), account: contaSlug ?? undefined }}
        titulo="Central do negócio"
        subtitulo={
          <>
            {contaLabel} · {periodo.rotulo}: {rotuloDoIntervalo(periodo.atual)}, comparado com {rotuloDoIntervalo(periodo.anterior)}.
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
              <FormularioFiltro action="/central" className="sb-periodo-form">
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
              </FormularioFiltro>
            </FilterMenu>

            <Link className="sb-button" href={contaSlug === null ? "/faturamento" : `/faturamento?account=${encodeURIComponent(contaSlug)}`}>
              Faturamento detalhado
            </Link>
          </>
        }
      />

      {/* D-472: a forma única do erro de leitura (D-502); o período inválido não é falha (item 13, D-503). */}
      {accountsResult.error !== null && (
        <EstadoDaTela
          tipo="erro"
          titulo="Não foi possível carregar as contas"
          descricao="O filtro de conta está indisponível."
          detalhe={accountsResult.error.message}
          acao={{ href: montarHref(periodoAtual, contaSlug), rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
        />
      )}

      {periodo.invalido && <AvisoDePeriodoInvalido rotulo={periodo.rotulo} />}

      {/*
        D-515: os dois esqueletos reservam o lugar do que vem. A "Atenção" tem o
        cabeçalho real e o espaço da lista; os indicadores (uns 3.000 px) ocupam
        ao menos a janela, e o que vem abaixo começa fora dela — com 142 px de
        esqueleto genérico, a chegada deles deu CLS de 0,39 em produção.
      */}
      <Suspense fallback={<AtencaoCarregando />}>
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

      <Suspense fallback={<CarregandoBloco rotulo="indicadores do período" altura="100vh" />}>
        <Indicadores
          leituras={leituras}
          leituraMeta={leituraMeta}
          leituraLimites={leituraLimites}
          periodo={periodo}
          podeEditar={podeEditar}
          tentarDeNovo={montarHref(periodoAtual, contaSlug)}
        />
      </Suspense>

      {/*
        D-480 (T8a, decisão do dono de 15/10): os indicadores acima são do
        Mercado Livre; a Shopee entra LADO A LADO, com a receita somada e sem
        total de resultado — o mesmo bloco do "Todos" de /faturamento (D-442),
        os mesmos números. É da empresa inteira, então só aparece sem conta do
        ML escolhida. Sem loja Shopee em produção com pedidos lidos, ele mesmo
        diz que a Shopee ainda não entra.
      */}
      {membership.organizationId !== null && selectedAccount === null && (
        <section aria-label="Por marketplace">
          <div className="sb-section-label">
            <span>Por marketplace</span>
            <span className="sb-section-note">a receita soma; o resultado de cada marketplace fica no dele</span>
          </div>
          <Suspense fallback={<CarregandoBloco rotulo="o lado a lado dos marketplaces" />}>
            {/* D-610: sem conta escolhida, o faturamento e o Ads do período atual
                são as MESMAS leituras dos indicadores (`leituras`): o bloco as
                reusa, em vez de chamar as duas RPCs de novo. */}
            <CorpoTodos
              organizationId={membership.organizationId}
              recorte={{ escopo: "todos", periodo: { from: periodo.atual.from, to: periodo.atual.to }, contas: null }}
              range={periodo.atual}
              leiturasDoMl={{
                faturamento: leituras.then(([atual]) => atual),
                ads: leituras.then(([, , adsAtual]) => adsAtual),
              }}
            />
          </Suspense>
        </section>
      )}

      <Suspense fallback={<CarregandoBloco rotulo="detector de frete" />}>
        <SinalDoFrete leitura={leituraFrete} tentarDeNovo={montarHref(periodoAtual, contaSlug)} />
      </Suspense>

      <Suspense fallback={<CarregandoBloco rotulo="sinais de Ads" />}>
        <SinalDeAds leitura={leituraAds} tentarDeNovo={montarHref(periodoAtual, contaSlug)} />
      </Suspense>
    </>
  );
}
