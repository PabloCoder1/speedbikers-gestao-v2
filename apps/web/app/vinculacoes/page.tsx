import Link from "next/link";
import { Suspense, type CSSProperties, type ReactNode } from "react";

import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { TOM } from "../../components/tone";
import { formatCount, formatCurrency } from "../../lib/format";
import {
  PAGE_SIZE,
  buildLinkIntegrityHref,
  resolveLinkIntegrityFilters,
  summarizeLinkIntegrityWindow,
  toRpcArgs,
  type LinkIntegrityFilters,
  type LinkStateKey,
  type SoldKey,
} from "../../lib/link-integrity-filters";
import { currentMembership } from "../../lib/request-membership";
import { createClient } from "../../lib/supabase/server";
import {
  iniciaisDaConta,
  lerVisaoVinculacoes,
  tonsDasContas,
  type ContagensVinculos,
  type VisaoVinculacoes,
} from "../../lib/vinculacoes-visao";

import { FilaCandidatos, TabelaVinculos, VincularPorMlb, type LinhaAnuncio } from "./vinculos-interativos";

export const metadata = { title: "Integridade de Catálogo — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Ver apps/web/app/importacoes/page.tsx para o mesmo raciocínio.
export const dynamic = "force-dynamic";

/**
 * Integridade de Catálogo (`/vinculacoes`) — D21, D-259, popup em D-374,
 * acabamento e leitura única em **D-376**.
 *
 * ## D-376, o pedido do dono
 *
 * "Melhore de novo a tela de vincular: você deixou mais fácil vincular, porém
 * não mexeu na qualidade visual da tela — deixe ela mais bonita e mais rápida."
 * Ele tinha razão nas duas metades:
 *
 * **A metade visual.** A D-374 trocou o JEITO de vincular (o popup) e deixou a
 * MOLDURA como estava: faixa de KPI e menus suspensos, a linguagem que
 * `/reposicao` (D-358), `/fornecedores` (D-366), `/compras` (D-365) e
 * `/produtos` (D-373) já tinham deixado para trás. Esta tela era a última da
 * família de estoque na gramática antiga. Agora ela usa as mesmas peças: um
 * RESUMO que responde "quanto disto está me custando dinheiro" e CARTÕES de
 * recorte que são um clique só, com a contagem dentro.
 *
 * **A metade rápida.** Medido em PRODUÇÃO como `authenticated` (4.447 anúncios):
 * a lista custava 180 ms e as quatro contagens da faixa mais 531 ms, porque
 * cada célula repetia `get_listings_dashboard` inteira com `p_limit => 1`.
 * `get_listings_link_overview` (D-376) faz tudo isso numa passagem só —
 * **91 ms a frio, 78 ms quente** — e ainda traz a linha por conta da
 * comparação, que antes esperava `get_link_integrity` (1,3 s).
 *
 * ## As duas fontes de "vendeu", e por que a tela mostra as duas
 *
 * A tabela e os cartões contam venda por `daily_listing_metrics` — a mesma
 * fonte, para que clicar num cartão mostre as linhas que ele promete (D-242).
 * `get_link_integrity` conta por `order_items`, um caminho INDEPENDENTE do
 * pipeline de métricas (D-128). Ela continua sendo lida, agora depois de tudo
 * e dentro de `Suspense`, só para conferir — e a tela nomeia a diferença em vez
 * de escondê-la.
 */

/** Uma linha de `get_link_integrity` — a fonte INDEPENDENTE, por conta. */
interface LinkIntegrityRow {
  ml_account_id: string;
  account_label: string;
  listings_total: number;
  com_vinculo: number;
  sem_vinculo: number;
  pct_vinculado: number;
  candidatos_abertos: number;
  vendidos_sem_vinculo: number;
  receita_sem_vinculo: number;
}

const JANELA_DIAS = 30;

/**
 * OS CARTÕES DE RECORTE, no desenho dos estados da reposição (D-358).
 *
 * Cada um é um clique que muda estado E venda de uma vez — antes eram dois
 * menus suspensos, e "vendeu sem vínculo", que é O trabalho desta tela, exigia
 * dois cliques em dois menus diferentes. A contagem de cada cartão sai da
 * MESMA leitura que monta a tabela, com o mesmo recorte de conta e de busca.
 */
const RECORTES: readonly {
  chave: string;
  rotulo: string;
  descricao: string;
  cor: string;
  state: LinkStateKey;
  sold: SoldKey;
  conta: (c: ContagensVinculos) => number;
}[] = [
  {
    chave: "todos",
    rotulo: "Todos",
    descricao: "anúncios sincronizados do Mercado Livre",
    cor: "var(--sb-primary)",
    state: "todos",
    sold: "todos",
    conta: (c) => c.todos,
  },
  {
    chave: "vinculados",
    rotulo: "Vinculados",
    descricao: "ligados a um SKU, direto ou por variação",
    cor: TOM.ok.color,
    state: "vinculados",
    sold: "todos",
    conta: (c) => c.vinculados,
  },
  {
    chave: "sem-vinculo",
    rotulo: "Sem vínculo",
    descricao: "nenhum SKU ligado ao anúncio",
    cor: TOM.atencao.color,
    state: "sem-vinculo",
    sold: "todos",
    conta: (c) => c.sem_vinculo,
  },
  {
    chave: "vendeu-sem-vinculo",
    rotulo: "Vendeu sem vínculo",
    descricao: "venda entrando sem baixa de estoque — comece por aqui",
    cor: TOM.perigo.color,
    state: "sem-vinculo",
    sold: "vendeu",
    conta: (c) => c.vendidos_sem_vinculo,
  },
  {
    chave: "parado-sem-vinculo",
    rotulo: "Parado sem vínculo",
    descricao: `sem venda nos últimos ${String(JANELA_DIAS)} dias`,
    cor: "var(--sb-muted-ink)",
    state: "sem-vinculo",
    sold: "nao-vendeu",
    conta: (c) => c.parados_sem_vinculo,
  },
];

/** "R$ 490,0 mil" — o destaque pede ordem de grandeza; o exato fica no `title`. */
const COMPACTO = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  notation: "compact",
  maximumFractionDigits: 1,
});

function recorteAtivo(filters: LinkIntegrityFilters): string {
  return RECORTES.find((r) => r.state === filters.state && r.sold === filters.sold)?.chave ?? "";
}

export default async function VinculacoesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const supabase = await createClient();
  const query = await searchParams;
  const filters = resolveLinkIntegrityFilters(query);

  /*
    As contas vêm ANTES do resto, e não junto: a leitura precisa do id da conta
    escolhida, e a URL traz o SLUG. Mesma ordem de `/anuncios` (D-242) — duas
    idas em série, não seis.
  */
  const [membership, contas] = await Promise.all([
    currentMembership(),
    // Só as contas que o usuário alcança — a RLS de `ml_accounts` decide.
    supabase.from("ml_accounts").select("id, slug, label").order("label"),
  ]);

  const organizationId = membership.organizationId;
  const accounts = contas.data ?? [];
  // Slug desconhecido cai em "todas as contas" em silêncio, como em `/anuncios`.
  const contaEscolhida = accounts.find((a) => a.slug === filters.accountSlug) ?? null;

  if (organizationId === null) {
    return (
      <Shell>
        <PageTitle
          eyebrow="ESTOQUE / VINCULAÇÕES"
          title="Integridade de Catálogo"
          subtitle="Garantia de que os anúncios estão corretamente ligados aos SKUs internos do sistema."
        />
        <p className="sb-empty">Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const hoje = new Date();
  const desde = new Date(hoje.getTime() - JANELA_DIAS * 24 * 60 * 60 * 1000);

  /*
    A LEITURA ÚNICA (D-376). Página, contagens dos cartões e a linha por conta
    da comparação numa ida só. O que antes eram cinco chamadas à mesma função
    pesada.
  */
  const leitura = await supabase.rpc("get_listings_link_overview", {
    p_organization_id: organizationId,
    p_date_from: desde.toISOString().slice(0, 10),
    p_date_to: hoje.toISOString().slice(0, 10),
    // A conta entra na JANELA: vale para a lista E para as contagens (D-236).
    p_ml_account_id: contaEscolhida?.id ?? null,
    ...toRpcArgs(filters),
    p_limit: PAGE_SIZE,
    p_offset: (filters.page - 1) * PAGE_SIZE,
    ...(filters.search !== null ? { p_search: filters.search } : {}),
  });

  const visao = leitura.error === null ? lerVisaoVinculacoes(leitura.data) : null;

  // Banco sem a migration (o Preview do PR, D-025) ou resposta fora do
  // contrato: a tela DIZ isso e cai para a lista de sempre, sem inventar
  // número nenhum nos cartões.
  if (visao === null) {
    return (
      <SemALeituraNova
        motivo={leitura.error?.message ?? "a leitura voltou fora do contrato esperado"}
        filters={filters}
        accounts={accounts}
        contaEscolhida={contaEscolhida}
        organizationId={organizationId}
        de={desde}
        ate={hoje}
      />
    );
  }

  // As duas listas dos painéis de baixo seguem o MESMO recorte de conta.
  const candidatosBase = supabase
    .from("link_candidates")
    .select("id, sku_key, ref_kind, item_id, variation_id, user_product_id, created_at, ml_accounts(label)")
    .eq("status", "OPEN");

  const manuaisBase = supabase
    .from("sku_listing_links")
    .select("id, item_id, variation_id, confirmed_at, skus(sku), ml_accounts(label)")
    .eq("source", "MANUAL");

  const naConta = <T extends { eq: (coluna: "ml_account_id", valor: string) => T }>(consulta: T): T =>
    contaEscolhida === null ? consulta : consulta.eq("ml_account_id", contaEscolhida.id);

  const [candidatos, manuais] = await Promise.all([
    naConta(candidatosBase).order("created_at", { ascending: true }).limit(200),
    naConta(manuaisBase).order("confirmed_at", { ascending: false, nullsFirst: false }).limit(8),
  ]);

  const abertos = candidatos.data ?? [];
  const window = summarizeLinkIntegrityWindow(filters.page, visao.total, visao.linhas.length);
  const contagens = visao.contagens;

  // A ordem é a da lista de contas (por rótulo, vinda do banco): o mesmo tom
  // para a mesma conta na faixa de selos, na tabela e na comparação.
  const tons = tonsDasContas(accounts.map((a) => a.id));

  const linhas: LinhaAnuncio[] = visao.linhas.map((r) => ({
    listingId: r.listing_id,
    itemId: r.item_id,
    title: r.title ?? r.item_id,
    mlAccountId: r.ml_account_id,
    accountLabel: r.account_label,
    contaTom: tons.get(r.ml_account_id) ?? 0,
    sku: r.sku,
    skuId: r.sku_id,
    linkState: r.link_state,
    unitsSold: r.units_sold,
    grossRevenue: r.gross_revenue,
    price: r.price ?? 0,
    fullQuantity: r.full_quantity,
  }));

  const contasOpcoes = accounts.map((a) => ({ id: a.id, label: a.label }));
  const ativo = recorteAtivo(filters);
  const filtroAtivo =
    filters.state !== "todos" || filters.sold !== "todos" || filters.accountSlug !== null || filters.search !== null;

  // Sem anúncio nenhum não há percentual: "0%" afirmaria que nenhum está
  // vinculado (D-254). Quem divide é o SQL na comparação; aqui o número do
  // resumo é o do recorte inteiro, e por isso vem da mesma leitura.
  const pctVinculado =
    contagens.todos === 0 ? null : Math.round((contagens.vinculados / contagens.todos) * 1000) / 10;

  return (
    <Shell>
      <PageTitle
        eyebrow="ESTOQUE / VINCULAÇÕES"
        title="Integridade de Catálogo"
        subtitle="Cada anúncio do Mercado Livre ligado ao SKU que ele vende — é o vínculo que faz a venda baixar estoque."
        aside={
          <>
            {/* A busca do frame, como GET nativo (D-136). */}
            <form method="get" action="/vinculacoes" className="sb-rep-busca" role="search">
              {filters.state !== "todos" && <input type="hidden" name="estado" value={filters.state} />}
              {filters.sold !== "todos" && <input type="hidden" name="venda" value={filters.sold} />}
              {contaEscolhida !== null && <input type="hidden" name="conta" value={contaEscolhida.slug} />}
              <input
                className="sb-input"
                type="search"
                name="busca"
                defaultValue={filters.search ?? ""}
                placeholder="MLB, título ou SKU"
                aria-label="Buscar por MLB, título ou SKU"
                maxLength={80}
              />
              <button type="submit" className="sb-button">
                Buscar
              </button>
            </form>
            <VincularPorMlb contas={contasOpcoes} />
          </>
        }
      />

      {/*
        O RESUMO — a pergunta que a tela responde é "quanto do meu catálogo
        está me custando dinheiro agora". O dinheiro vem primeiro; a saúde
        geral, depois.
      */}
      <section className="sb-rep-resumo sb-vnc-resumo" aria-label="Resumo da integridade do catálogo">
        <Link
          className={
            contagens.receita_sem_vinculo > 0
              ? "sb-rep-destaque sb-rep-destaque-perigo sb-vnc-destaque-link"
              : "sb-rep-destaque sb-vnc-destaque-link"
          }
          href={buildLinkIntegrityHref(filters, { state: "sem-vinculo", sold: "vendeu", page: 1 })}
          title={formatCurrency(contagens.receita_sem_vinculo)}
        >
          <span className="sb-rep-destaque-rotulo">Receita sem vínculo</span>
          <strong>{COMPACTO.format(contagens.receita_sem_vinculo)}</strong>
          <span className="sb-rep-destaque-nota">
            {contagens.vendidos_sem_vinculo === 0 ? (
              <>nenhum anúncio sem vínculo vendeu em {JANELA_DIAS} dias</>
            ) : (
              <>
                {formatCount(contagens.vendidos_sem_vinculo)} anúncio(s) venderam{" "}
                {formatCount(contagens.unidades_sem_vinculo)} un em {JANELA_DIAS} dias sem baixar estoque
              </>
            )}
          </span>
        </Link>

        <div className="sb-rep-destaque">
          <span className="sb-rep-destaque-rotulo">Catálogo vinculado</span>
          <strong>
            {pctVinculado === null ? "—" : `${pctVinculado.toLocaleString("pt-BR")}%`}
            <small className="sb-vnc-de">
              {formatCount(contagens.vinculados)} de {formatCount(contagens.todos)}
            </small>
          </strong>
          <span className="sb-vnc-barra" aria-hidden="true">
            <i style={{ width: `${String(pctVinculado ?? 0)}%` }} />
          </span>
          <span className="sb-rep-destaque-nota">
            {/* A distinção que D-122 mediu: nulo em `sku_id` NÃO é "sem vínculo". */}
            {formatCount(contagens.por_variacao)} deles por variação — têm `sku_id` nulo e estão ligados
          </span>
        </div>

        <Link
          className="sb-rep-destaque sb-vnc-destaque-link"
          href={buildLinkIntegrityHref(filters, { state: "sem-vinculo", sold: "todos", page: 1 })}
        >
          <span className="sb-rep-destaque-rotulo">Falta vincular</span>
          <strong>{formatCount(contagens.sem_vinculo)}</strong>
          <span className="sb-rep-destaque-nota">
            {formatCount(contagens.vendidos_sem_vinculo)} venderam e {formatCount(contagens.parados_sem_vinculo)} estão
            parados
          </span>
        </Link>

        <div className="sb-rep-destaque">
          <span className="sb-rep-destaque-rotulo">Candidatos do ERP</span>
          <strong>{formatCount(contagens.candidatos_abertos)}</strong>
          <span className="sb-rep-destaque-nota">
            {contagens.candidatos_abertos === 0
              ? "nenhuma linha do ERP ficou sem SKU"
              : "linhas da planilha que citaram um SKU inexistente"}
            {filters.search !== null && <em className="sb-vnc-ressalva"> · a fila não segue a busca</em>}
          </span>
        </div>
      </section>

      {/* OS RECORTES como cartões: estado e venda num clique só. */}
      <nav className="sb-rep-estados sb-vnc-recortes" aria-label="Recortes do catálogo">
        {RECORTES.map((recorte) => {
          const marcado = ativo === recorte.chave;

          return (
            <Link
              key={recorte.chave}
              href={buildLinkIntegrityHref(filters, {
                // Clicar de novo no cartão marcado volta para "Todos": o
                // cartão é um interruptor, não um caminho sem volta.
                state: marcado ? "todos" : recorte.state,
                sold: marcado ? "todos" : recorte.sold,
                page: 1,
              })}
              className={marcado ? "sb-rep-estado sb-rep-estado-ativo" : "sb-rep-estado"}
              style={{ "--sb-rep-tom": recorte.cor } as CSSProperties}
              aria-current={marcado ? "true" : undefined}
            >
              <span className="sb-rep-estado-rotulo">{recorte.rotulo}</span>
              <strong>{formatCount(recorte.conta(contagens))}</strong>
              <small>{recorte.descricao}</small>
            </Link>
          );
        })}
      </nav>

      {/* AS CONTAS como selos: quatro contas não pedem um menu suspenso. */}
      {accounts.length > 1 && (
        <nav className="sb-vnc-contas" aria-label="Filtrar por conta">
          <Link
            className={contaEscolhida === null ? "sb-vnc-conta-chip sb-vnc-conta-chip-ativo" : "sb-vnc-conta-chip"}
            href={buildLinkIntegrityHref(filters, { accountSlug: null, page: 1 })}
            aria-current={contaEscolhida === null ? "true" : undefined}
          >
            Todas as contas
          </Link>
          {accounts.map((a) => {
            const marcada = contaEscolhida?.id === a.id;
            const naComparacao = visao.porConta.find((c) => c.ml_account_id === a.id) ?? null;

            return (
              <Link
                key={a.id}
                className={marcada ? "sb-vnc-conta-chip sb-vnc-conta-chip-ativo" : "sb-vnc-conta-chip"}
                href={buildLinkIntegrityHref(filters, { accountSlug: marcada ? null : a.slug, page: 1 })}
                aria-current={marcada ? "true" : undefined}
              >
                <span className="sb-vnc-selo" data-tom={tons.get(a.id) ?? 0} aria-hidden="true">
                  {iniciaisDaConta(a.label)}
                </span>
                {a.label}
                {naComparacao !== null && naComparacao.sem_vinculo > 0 && (
                  <em>{formatCount(naComparacao.sem_vinculo)}</em>
                )}
              </Link>
            );
          })}
        </nav>
      )}

      <Panel
        title="Anúncios do Mercado Livre"
        subtitle={
          <>
            {filters.search !== null && (
              <>
                Busca por <b>“{filters.search}”</b> ·{" "}
              </>
            )}
            {window.label} Do que mais faturou em {JANELA_DIAS} dias ao que menos — o de cima é o que custa mais caro
            deixar sem vínculo. <b>Vincular</b> abre o popup sobre a tabela, já com a sugestão dos pedidos.
          </>
        }
        aside={
          filtroAtivo ? (
            <Link className="sb-button" href="/vinculacoes">
              Limpar filtros
            </Link>
          ) : null
        }
      >
        {linhas.length === 0 ? (
          <div className="sb-vnc-vazio">
            <b>{window.label}</b>
            {filtroAtivo ? (
              <>
                <span>Nenhum anúncio neste recorte.</span>
                <Link className="sb-button" href="/vinculacoes">
                  Limpar filtros
                </Link>
              </>
            ) : (
              <span>Assim que a sincronização trouxer anúncios, eles aparecem aqui.</span>
            )}
          </div>
        ) : (
          <TabelaVinculos
            linhas={linhas}
            contas={contasOpcoes}
            abrirItem={typeof query.item === "string" ? query.item : null}
            janelaDias={JANELA_DIAS}
          />
        )}

        {window.totalPages > 1 && (
          <nav className="sb-vnc-paginas" aria-label="Páginas">
            {filters.page > 1 && (
              <Link className="sb-button" href={buildLinkIntegrityHref(filters, { page: filters.page - 1 })}>
                ‹ Anterior
              </Link>
            )}
            <span>
              Página {filters.page} de {window.totalPages}
            </span>
            {filters.page < window.totalPages && (
              <Link className="sb-button" href={buildLinkIntegrityHref(filters, { page: filters.page + 1 })}>
                Próxima ›
              </Link>
            )}
          </nav>
        )}
      </Panel>

      <div className="sb-vnc-duas">
        <Panel
          title="Candidatos da importação do ERP"
          subtitle="Linhas da planilha que citaram um SKU inexistente no catálogo. Match exato resolve sozinho numa importação futura; esta fila é a confirmação humana do resto."
        >
          {candidatos.error !== null ? (
            <p role="alert" className="sb-note sb-note-perigo">
              Não foi possível carregar os candidatos: {candidatos.error.message}
            </p>
          ) : (
            <FilaCandidatos
              contas={contasOpcoes}
              candidatos={abertos.map((c) => ({
                id: c.id,
                skuKey: c.sku_key,
                accountLabel: c.ml_accounts.label,
                referencia: `${c.item_id ?? c.user_product_id ?? "—"}${c.variation_id !== null ? ` · var ${c.variation_id}` : ""}`,
                createdAt: c.created_at,
              }))}
            />
          )}
        </Panel>

        {/* Leitura de volta: o operador vê o que acabou de vincular à mão. */}
        <Panel title="Últimos vínculos manuais" subtitle="Os mais recentes feitos por pessoas, nesta conta ou em todas.">
          {(manuais.data ?? []).length === 0 ? (
            <p className="sb-empty">Nenhum vínculo manual ainda.</p>
          ) : (
            <ul className="sb-vnc-recentes">
              {(manuais.data ?? []).map((m) => (
                <li key={m.id}>
                  <b className="sb-mono">{m.skus.sku}</b>
                  <span aria-hidden="true">←</span>
                  <Link className="sb-mono" href={`/anuncios/${m.item_id ?? ""}`}>
                    {m.item_id ?? "—"}
                  </Link>
                  {m.variation_id !== null && <small className="sb-mono">var {m.variation_id}</small>}
                  <small>{m.ml_accounts.label}</small>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {/*
        A COMPARAÇÃO ENTRE CONTAS (D-128) chega COM a página desde a D-376: as
        colunas de catálogo saem da mesma leitura. NÃO obedece ao filtro de
        conta de propósito — comparar é o serviço deste painel.
      */}
      <Panel
        title="Comparação entre contas"
        subtitle="Uma linha por conta, sem o filtro acima. Clique numa conta para recortar a tabela. As colunas usam a mesma definição de vínculo dos cartões (D-122)."
      >
        <ComparacaoDeCatalogo
          visao={visao}
          contaEscolhidaId={contaEscolhida?.id ?? null}
          filters={filters}
          tons={tons}
        />

        {/*
          A conferência com a fonte INDEPENDENTE chega depois: é a única parte
          que depende de `get_link_integrity` (1,3 s em produção).
        */}
        <Suspense
          fallback={
            <p className="sb-vnc-conferencia" role="status">
              <span className="sb-vnc-girando" aria-hidden="true" /> Conferindo com os pedidos…
            </p>
          }
        >
          <ConferenciaComOsPedidos
            organizationId={organizationId}
            contaEscolhidaId={contaEscolhida?.id ?? null}
            vendidosSemVinculoTabela={contagens.vendidos_sem_vinculo}
          />
        </Suspense>
      </Panel>
    </Shell>
  );
}

/** A tabela da comparação, direto da leitura única — sem espera. */
function ComparacaoDeCatalogo({
  visao,
  contaEscolhidaId,
  filters,
  tons,
}: {
  visao: VisaoVinculacoes;
  contaEscolhidaId: string | null;
  filters: LinkIntegrityFilters;
  tons: ReadonlyMap<string, number>;
}): ReactNode {
  if (visao.porConta.length === 0) return <p className="sb-empty">Nenhuma conta do Mercado Livre conectada.</p>;

  return (
    <div className="sb-vnc-tabela-rolagem">
      <table className="sb-table">
        <thead>
          <tr>
            <th>Conta</th>
            <th className="sb-num">Anúncios</th>
            <th className="sb-num">Vinculados</th>
            <th className="sb-num">Sem vínculo</th>
            <th>% vinculado</th>
            <th className="sb-num">Candidatos</th>
            <th className="sb-num">Vendeu sem vínculo</th>
          </tr>
        </thead>

        <tbody>
          {visao.porConta.map((linha) => {
            const selecionada = contaEscolhidaId === linha.ml_account_id;

            return (
              <tr key={linha.ml_account_id} className={selecionada ? "sb-vnc-conta-foco" : undefined}>
                <td>
                  <span className="sb-vnc-conta-celula">
                    <span className="sb-vnc-selo" data-tom={tons.get(linha.ml_account_id) ?? 0} aria-hidden="true">
                      {iniciaisDaConta(linha.account_label)}
                    </span>
                    {linha.account_slug === null ? (
                      linha.account_label
                    ) : (
                      <Link
                        className="sb-entity"
                        aria-current={selecionada ? "true" : undefined}
                        href={buildLinkIntegrityHref(filters, {
                          accountSlug: selecionada ? null : linha.account_slug,
                          page: 1,
                        })}
                      >
                        {linha.account_label}
                      </Link>
                    )}
                    {selecionada && <small className="sb-vnc-mudo">em foco</small>}
                  </span>
                </td>
                <td className="sb-num">{formatCount(linha.listings_total)}</td>
                <td className="sb-num">{formatCount(linha.com_vinculo)}</td>
                <td className="sb-num">{formatCount(linha.sem_vinculo)}</td>
                <td>
                  {/* Sem anúncio nenhum não há percentual — "0%" afirmaria que nenhum está vinculado. */}
                  {linha.pct_vinculado === null ? (
                    "—"
                  ) : (
                    <span className="sb-vnc-pct">
                      <span className="sb-vnc-pct-barra" aria-hidden="true">
                        <i style={{ width: `${String(Math.min(100, Math.max(0, linha.pct_vinculado)))}%` }} />
                      </span>
                      {linha.pct_vinculado.toLocaleString("pt-BR")}%
                    </span>
                  )}
                </td>
                <td className="sb-num">{formatCount(linha.candidatos_abertos)}</td>
                <td className="sb-num">
                  {linha.vendidos_sem_vinculo > 0 ? (
                    <b className="sb-vnc-vendas-alerta">{formatCount(linha.vendidos_sem_vinculo)}</b>
                  ) : (
                    formatCount(0)
                  )}
                  <small className="sb-vnc-bloco">{formatCurrency(linha.receita_sem_vinculo)}</small>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A CONFERÊNCIA com a fonte independente (`get_link_integrity`, a partir de
 * `order_items`). Chega depois da página inteira, de propósito: mede 1,3 s a
 * frio em produção e não é o que a pessoa veio fazer aqui.
 *
 * Ela não repete as colunas de catálogo — a comparação acima já as tem, da
 * mesma leitura. O que ela acrescenta é a DIFERENÇA entre as duas fontes, que
 * é a única coisa que só ela sabe.
 */
async function ConferenciaComOsPedidos({
  organizationId,
  contaEscolhidaId,
  vendidosSemVinculoTabela,
}: {
  organizationId: string;
  contaEscolhidaId: string | null;
  vendidosSemVinculoTabela: number;
}): Promise<ReactNode> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_link_integrity", {
    p_organization_id: organizationId,
    p_days: JANELA_DIAS,
  });

  if (error !== null) {
    return (
      <p className="sb-vnc-conferencia">
        A conferência com os pedidos não pôde ser lida agora ({error.message}). Os números acima são do catálogo e
        continuam valendo.
      </p>
    );
  }

  const porPedidos = data as LinkIntegrityRow[];

  if (porPedidos.length === 0) return null;

  const doRecorte =
    contaEscolhidaId === null ? porPedidos : porPedidos.filter((l) => l.ml_account_id === contaEscolhidaId);
  const vendidosPorPedido = doRecorte.reduce((soma, l) => soma + l.vendidos_sem_vinculo, 0);
  const receitaPorPedido = doRecorte.reduce((soma, l) => soma + l.receita_sem_vinculo, 0);
  const divergencia = vendidosPorPedido - vendidosSemVinculoTabela;
  const filaVaziaComVenda = porPedidos.some((l) => l.vendidos_sem_vinculo > 0 && l.candidatos_abertos === 0);

  return (
    <div className="sb-vnc-conferencia">
      <p>
        <b>Conferido pelos pedidos.</b> Contando direto de <code>order_items</code> — um caminho que não passa pelo
        pipeline de métricas — são <b>{formatCount(vendidosPorPedido)}</b> anúncios vendidos sem vínculo e{" "}
        <b>{formatCurrency(receitaPorPedido)}</b> em {JANELA_DIAS} dias.
        {divergencia === 0 ? (
          " Bate com o número do catálogo acima."
        ) : divergencia > 0 ? (
          <>
            {" "}
            São {formatCount(divergencia)} a mais que o catálogo: o pipeline de métricas ainda não os conhece.
          </>
        ) : (
          <>
            {" "}
            São {formatCount(-divergencia)} a menos que o catálogo: há venda contada por métrica que ainda não virou
            pedido lido.
          </>
        )}
      </p>

      {/*
        A divergência que D-117 mediu: a fila de candidatos só conhece a
        planilha do UpSeller.
      */}
      {filaVaziaComVenda && (
        <p>
          <b>Divergência:</b> há conta com anúncio que vendeu sem vínculo e fila de candidatos vazia. O gerador de
          candidatos só conhece a planilha do UpSeller — esses saem pelo <b>Vincular</b> da tabela.
        </p>
      )}
    </div>
  );
}

/**
 * O CAMINHO SEM A LEITURA NOVA — o Preview do PR antes de a migration entrar na
 * `v3` (D-025), ou uma resposta fora do contrato.
 *
 * Mostra a tabela e o popup, que é o trabalho, e DIZ que os cartões não estão
 * disponíveis. Não tenta remontá-los com as cinco chamadas antigas: a receita
 * sem vínculo só existe somada no SQL, e somar linha por linha no JS seria
 * exatamente o que a casa não faz.
 */
async function SemALeituraNova({
  motivo,
  filters,
  accounts,
  contaEscolhida,
  organizationId,
  de,
  ate,
}: {
  motivo: string;
  filters: LinkIntegrityFilters;
  accounts: readonly { id: string; slug: string; label: string }[];
  contaEscolhida: { id: string; slug: string; label: string } | null;
  organizationId: string;
  de: Date;
  ate: Date;
}): Promise<ReactNode> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_listings_dashboard", {
    p_organization_id: organizationId,
    p_date_from: de.toISOString().slice(0, 10),
    p_date_to: ate.toISOString().slice(0, 10),
    p_ml_account_id: contaEscolhida?.id ?? null,
    ...toRpcArgs(filters),
    p_limit: PAGE_SIZE,
    p_offset: (filters.page - 1) * PAGE_SIZE,
    ...(filters.search !== null ? { p_search: filters.search } : {}),
  });

  const rows = data ?? [];
  const window = summarizeLinkIntegrityWindow(filters.page, rows[0]?.total_count ?? 0, rows.length);

  return (
    <Shell>
      <PageTitle
        eyebrow="ESTOQUE / VINCULAÇÕES"
        title="Integridade de Catálogo"
        subtitle="Cada anúncio do Mercado Livre ligado ao SKU que ele vende — é o vínculo que faz a venda baixar estoque."
        aside={<VincularPorMlb contas={accounts.map((a) => ({ id: a.id, label: a.label }))} />}
      />

      <p role="status" className="sb-note sb-note-atencao">
        Os cartões de resumo e a comparação entre contas não estão disponíveis neste banco: {motivo}. A tabela e o
        vínculo continuam funcionando.
      </p>

      {error !== null ? (
        <p role="alert" className="sb-note sb-note-perigo">
          Não foi possível carregar os anúncios: {error.message}
        </p>
      ) : (
        <Panel title="Anúncios do Mercado Livre" subtitle={window.label}>
          {rows.length === 0 ? (
            <p className="sb-empty">{window.label}</p>
          ) : (
            <TabelaVinculos
              linhas={rows.map((r) => ({
                listingId: r.listing_id,
                itemId: r.item_id,
                title: r.title,
                mlAccountId: r.ml_account_id,
                accountLabel: r.account_label,
                contaTom: accounts.findIndex((a) => a.id === r.ml_account_id) % 6,
                // O tipo gerado diz `string`, mas vínculo por variação tem
                // `sku_id` nulo e está ligado (D-122).
                sku: (r as { sku: string | null }).sku,
                skuId: (r as { sku_id: string | null }).sku_id,
                linkState: r.link_state,
                unitsSold: r.units_sold,
                grossRevenue: r.gross_revenue,
                price: r.price,
                fullQuantity: r.full_quantity,
              }))}
              contas={accounts.map((a) => ({ id: a.id, label: a.label }))}
              abrirItem={null}
              janelaDias={JANELA_DIAS}
            />
          )}
        </Panel>
      )}
    </Shell>
  );
}
