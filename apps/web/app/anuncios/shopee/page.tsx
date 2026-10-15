/*
 * DESVIO DE DESENHO (formato de docs/DESIGN_IMPLEMENTATION.md):
 * **Superfície:** `/anuncios/shopee` · **Figma:** não há frame para a Shopee ·
 * **V3 real:** catálogo das lojas Shopee com o vínculo pelo SKU do anúncio
 * (D-428) e o vínculo manual, que vence (D-429) · **Decisão:** compor com o
 * Design Contract e os componentes que `/anuncios` já usa (PageTitle,
 * KpiStrip, Panel, FilterMenu, StatePill, `.sb-table` e as classes
 * `.sb-an-*`), e o vínculo manual com o popup e a busca de SKU de
 * `/vinculacoes` (`.sb-vnc-modal`, `BuscaSku`), sem forma nova · **Motivo:**
 * escopo enxuto — o Figma não desenhou o segundo canal.
 */
import Link from "next/link";
import type { ReactNode } from "react";

import { FilterMenu } from "../../../components/filter-menu";
import { Icone } from "../../../components/icons";
import { KpiStrip, type KpiCellData } from "../../../components/kpi-strip";
import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { SeletorDeMarketplace } from "../../../components/seletor-marketplace";
import { Shell } from "../../../components/shell";
import { StatePill } from "../../../components/state-pill";
import { FormularioFiltro } from "../../../components/formulario-filtro";
import { LinkDeFiltro } from "../../../components/link-de-filtro";
import { formatCount, formatDateTime } from "../../../lib/format";
import { monogramaDeProduto } from "../../../lib/initials";
import { pageNumbers } from "../../../lib/listings-dashboard";
import { contarContasMl, hrefDosAnuncios } from "../../../lib/marketplace";
import { formatAge } from "../../../lib/relative-time";
import { currentMembership } from "../../../lib/request-membership";
import { sanitizeErrorText } from "../../../lib/sanitize";
import { acaoDoVinculoShopee, podeVincularShopee, skuQueOAnuncioIndica } from "../../../lib/shopee-link";
import {
  SHOPEE_LINK_STATES,
  SHOPEE_PAGE_SIZE,
  buildShopeeKpiHref,
  buildShopeeListingsHref,
  explicacaoDoAguardando,
  formatShopeeMoney,
  isShopeeSchemaMissing,
  resolveShopeeListingsFilters,
  shopeeImageUrl,
  shopeeItemStatus,
  shopeeLinkState,
  shopeeModelUnavailable,
  summarizeShopeeWindow,
} from "../../../lib/shopee-listings";
import { createClient } from "../../../lib/supabase/server";

import { AcoesDoVinculoShopee } from "./acoes-vinculo-shopee";

export const metadata = { title: "Anúncios da Shopee — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio de apps/web/app/anuncios/page.tsx.
export const dynamic = "force-dynamic";

/**
 * Anúncios da Shopee (D-428, fatia 4a da trilha Shopee).
 *
 * Uma linha por UNIDADE de anúncio — cada variação, ou o item quando não há
 * variação —, como `shopee_listing_units` define. O vínculo é o SKU que o
 * vendedor digitou no anúncio, normalizado como `skus.sku_key`, igual a um SKU
 * do catálogo: DERIVADO na leitura, nunca gravado.
 *
 * **O vínculo manual (D-429, fatia 4b) VENCE o do anúncio.** Ele é gravado
 * aqui, pelo popup da coluna "Vínculo", e só por quem tem papel ADMIN, GESTOR
 * ou OPERADOR na organização — o mesmo corte de `set_shopee_sku_link` e
 * `remove_shopee_sku_link`; a tela esconde os botões de quem não pode, e o
 * banco recusa do mesmo jeito. A unidade só aceita vínculo depois de lida
 * (D-316): a linha "aguardando leitura" não oferece botão.
 *
 * Lista e faixa saem de `get_shopee_listings` (paginada no SQL, com
 * `total_count`) e `get_shopee_listings_summary` (contadores no SQL — o
 * "Vinculados" já conta o manual). A Shopee é lida pelo worker, de hora em
 * hora; esta tela nunca a chama, e o vínculo não muda nada no anúncio de lá.
 *
 * Nada aqui toca o Mercado Livre: `/anuncios` continua com as RPCs e as
 * contagens dele, e só ganhou um link para cá.
 */

const DESCRICAO =
  "Catálogo das lojas Shopee, lido de hora em hora. O vínculo vem do SKU que o vendedor digitou no anúncio — o da " +
  "variação, ou o do item quando não há variação — comparado ao catálogo, ou de um vínculo manual feito aqui, que vence " +
  "o do anúncio.";

/**
 * Sem catálogo para listar, o seletor de marketplace não aparece (ele mora no
 * cabeçalho da lista): o caminho de volta fica no texto.
 */
const SUBTITULO = (
  <>
    {DESCRICAO} Os anúncios do Mercado Livre estão no <Link href="/anuncios">Dashboard de anúncios</Link>.
  </>
);

/** Estado sem tabela (vazio, banco anterior, erro), na forma de `/anuncios`. */
function Estado({ titulo, children, erro = false }: { titulo: string; children?: ReactNode; erro?: boolean }): ReactNode {
  return (
    <div className={erro ? "sb-an-estado sb-an-estado-erro" : "sb-an-estado"} role={erro ? "alert" : undefined}>
      <b>{titulo}</b>
      {children}
    </div>
  );
}

/** A tela sem catálogo para listar: o cabeçalho e um painel com o motivo. */
function SemCatalogo({ children }: { children: ReactNode }): ReactNode {
  return (
    <Shell>
      <PageTitle eyebrow="COMERCIAL / CATÁLOGO" title="Anúncios da Shopee" subtitle={SUBTITULO} />
      <div className="sb-an-lista">
        <Panel title="Anúncios e vínculos">{children}</Panel>
      </div>
    </Shell>
  );
}

export default async function AnunciosShopeePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const supabase = await createClient();

  // As lojas não dependem da organização (a RLS já as restringe): saem junto
  // com o membership, como as contas em `/anuncios` (D-195).
  const [membership, lojasResult, contasMl] = await Promise.all([
    currentMembership(),
    supabase
      .from("shopee_shops")
      .select("id, organization_id, shop_name, shop_id, environment, status")
      .order("connected_at", { ascending: true }),
    // D-431: só o NÚMERO de contas do Mercado Livre, para o seletor de
    // marketplace oferecer a volta a `/anuncios`.
    contarContasMl(supabase),
  ]);

  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <SemCatalogo>
        <Estado titulo="Sua conta não está associada a nenhuma organização." />
      </SemCatalogo>
    );
  }

  // Tabela das lojas ausente (banco anterior a 20261013120000): a mesma
  // estratégia de `/contas` — a novidade ainda não chegou, não é erro.
  if (lojasResult.error !== null) {
    return (
      <SemCatalogo>
        {isShopeeSchemaMissing(lojasResult.error) ? (
          <Estado titulo="Os anúncios da Shopee chegam com a próxima atualização do banco." />
        ) : (
          <Estado titulo="Não foi possível ler as lojas Shopee." erro>
            <span>{sanitizeErrorText(lojasResult.error.message) ?? "A leitura falhou neste carregamento."}</span>
          </Estado>
        )}
      </SemCatalogo>
    );
  }

  const lojas = lojasResult.data.filter((loja) => loja.organization_id === organizationId);
  // Quem vê os botões do vínculo manual: o mesmo corte das RPCs de escrita.
  const podeVincular = podeVincularShopee(membership.role);

  if (lojas.length === 0) {
    return (
      <SemCatalogo>
        <Estado titulo="Nenhuma loja Shopee conectada.">
          <span>Conecte a loja em Contas; o catálogo é lido de hora em hora depois da conexão.</span>
          <Link className="sb-button" href="/contas">
            Conectar loja em Contas
          </Link>
        </Estado>
      </SemCatalogo>
    );
  }

  const filters = resolveShopeeListingsFilters(
    query,
    lojas.map((loja) => loja.id),
  );
  const estadoAtivo = SHOPEE_LINK_STATES.find((estado) => estado.slug === filters.estado) ?? null;
  const lojaAtiva = lojas.find((loja) => loja.id === filters.loja) ?? null;
  const nomeDaLoja = (loja: { shop_name: string | null; shop_id: number }): string =>
    loja.shop_name ?? `Loja ${String(loja.shop_id)}`;
  // O mesmo nome no menu e na coluna "Loja" da tabela.
  const nomePorId = new Map(lojas.map((loja) => [loja.id, nomeDaLoja(loja)]));

  /*
    A leitura de hora em hora só visita loja CONECTADA (`triggerShopeeOrdersSync`
    filtra `status = 'CONNECTED'`). Loja com a conexão em erro não é relida, e
    a tela não pode prometer "na próxima hora" para ela.
  */
  const lojasNoEscopo = lojaAtiva === null ? lojas : [lojaAtiva];
  const lojasSemConexao = lojasNoEscopo.filter((loja) => loja.status !== "CONNECTED");
  const leituraParada = lojasSemConexao.length === lojasNoEscopo.length;

  /*
    Duas leituras em paralelo: a página e a faixa. O ESCOPO da faixa é a loja,
    sem estado nem busca — cada célula É um filtro de estado, e contá-la já
    filtrada por outro daria sempre zero ou o próprio número.
  */
  const [lista, resumo] = await Promise.all([
    supabase.rpc("get_shopee_listings", {
      p_organization_id: organizationId,
      p_shopee_shop_id: filters.loja,
      p_estado: estadoAtivo?.codigo ?? null,
      p_busca: filters.busca,
      p_limit: SHOPEE_PAGE_SIZE,
      p_offset: (filters.pagina - 1) * SHOPEE_PAGE_SIZE,
    }),
    supabase.rpc("get_shopee_listings_summary", {
      p_organization_id: organizationId,
      p_shopee_shop_id: filters.loja,
    }),
  ]);

  // Catálogo ausente (banco anterior a 20261013180000): as RPCs não existem.
  const catalogoAusente = isShopeeSchemaMissing(lista.error) || isShopeeSchemaMissing(resumo.error);

  if (catalogoAusente) {
    return (
      <SemCatalogo>
        <Estado titulo="O catálogo da Shopee chega com a próxima atualização do banco." />
      </SemCatalogo>
    );
  }

  const rows = lista.data ?? [];
  // `total_count` vem repetido em toda linha (window function); zero linhas é
  // zero no conjunto filtrado.
  const totalCount = rows[0]?.total_count ?? 0;
  const janela = summarizeShopeeWindow(filters.pagina, totalCount, rows.length);

  // Contagem em erro é `undefined` e a célula diz "—", nunca zero (D-067).
  const contagens = resumo.error === null ? (resumo.data[0] ?? null) : null;
  const ultimaLeitura = contagens?.ultima_leitura ?? null;
  // Catálogo NUNCA lido: "0 anúncios" afirmaria uma loja vazia que ninguém
  // olhou. Os contadores ficam "—" até a primeira leitura.
  const nuncaLido = contagens !== null && ultimaLeitura === null && contagens.anuncios === 0;
  const numero = (valor: number | undefined): string =>
    valor === undefined || nuncaLido ? "—" : formatCount(valor);

  const agora = new Date();
  const celulas: KpiCellData[] = [
    {
      label: "Anúncios",
      formula:
        "Cada variação, ou o item quando não há variação, nas lojas do recorte — sem o filtro de vínculo nem a busca; itens apagados ficam de fora.",
      value: numero(contagens?.anuncios),
      previous: null,
      ...(contagens === null || nuncaLido
        ? {}
        : { ressalva: `em ${formatCount(contagens.itens)} ${contagens.itens === 1 ? "item" : "itens"}` }),
      // A faixa conta sem a busca: o "ver lista" também a larga.
      href: buildShopeeKpiHref(filters, null),
      tom: "info",
    },
    ...SHOPEE_LINK_STATES.map(
      (estado): KpiCellData => ({
        label: estado.rotulo,
        formula: estado.criterio,
        value: numero(
          contagens === null
            ? undefined
            : {
                VINCULADO: contagens.vinculados,
                SEM_SKU_NO_ANUNCIO: contagens.sem_sku_no_anuncio,
                SKU_FORA_DO_CATALOGO: contagens.sku_fora_do_catalogo,
                AGUARDANDO_LEITURA: contagens.aguardando_leitura,
              }[estado.codigo],
        ),
        previous: null,
        // "Vinculados" soma as duas origens (D-429); a célula diz quais.
        ...(estado.codigo === "VINCULADO" && contagens !== null && !nuncaLido ? { ressalva: estado.explicacao } : {}),
        href: buildShopeeKpiHref(filters, estado.slug),
        tom: estado.tom,
      }),
    ),
    {
      label: "Última leitura do catálogo",
      formula: "Até onde a lista de itens da loja já foi lida na Shopee; a leitura roda de hora em hora.",
      value: ultimaLeitura === null ? "—" : (formatAge(ultimaLeitura, agora) ?? formatDateTime(ultimaLeitura)),
      previous: null,
      ressalva:
        contagens === null
          ? "Não foi possível ler agora."
          : `${ultimaLeitura === null ? "Ainda não lido" : formatDateTime(ultimaLeitura)} — ${
              leituraParada
                ? "a leitura está parada: a conexão da loja está com erro."
                : "a leitura roda de hora em hora."
            }`,
    },
  ];

  const chips: { rotulo: string; href: string }[] = [
    ...(lojaAtiva === null ? [] : [{ rotulo: nomeDaLoja(lojaAtiva), href: buildShopeeListingsHref(filters, { loja: null }) }]),
    ...(estadoAtivo === null
      ? []
      : [{ rotulo: estadoAtivo.rotulo, href: buildShopeeListingsHref(filters, { estado: null }) }]),
    ...(filters.busca === null
      ? []
      : [{ rotulo: `Busca “${filters.busca}”`, href: buildShopeeListingsHref(filters, { busca: null }) }]),
  ];
  const limpar = buildShopeeListingsHref(filters, { loja: null, estado: null, busca: null });
  const temFiltro = estadoAtivo !== null || filters.busca !== null;
  // Página além do fim: zero linhas não diz o total do filtro — a janela
  // diria "nenhum anúncio no filtro atual", e o filtro pode ter centenas.
  const alemDoFim = lista.error === null && rows.length === 0 && filters.pagina > 1;

  const hidden = (nome: string, valor: string | null): ReactNode =>
    valor === null ? null : <input type="hidden" name={nome} value={valor} />;

  return (
    <Shell>
      <PageTitle
        eyebrow="COMERCIAL / CATÁLOGO"
        title="Anúncios da Shopee"
        subtitle={DESCRICAO}
        aside={
          <>
            {/* O marketplace primeiro, como em `/anuncios` (D-431): a volta
                leva só a busca — loja e estado são da Shopee. */}
            <SeletorDeMarketplace
              ativo="shopee"
              contas={{ ml: contasMl, shopee: lojas.length }}
              destinos={{ ml: hrefDosAnuncios("ml", filters.busca), shopee: buildShopeeListingsHref(filters) }}
            />

            {/* Todo o recorte vive na URL, nunca em estado React — link
                compartilhável e voltar do navegador, como em `/anuncios`. */}
            <FilterMenu
              rotulo={lojaAtiva === null ? "Todas as lojas" : nomeDaLoja(lojaAtiva)}
              opcoes={[
                { href: buildShopeeListingsHref(filters, { loja: null }), ativo: lojaAtiva === null, label: "Todas as lojas" },
                ...lojas.map((loja) => ({
                  href: buildShopeeListingsHref(filters, { loja: loja.id }),
                  ativo: lojaAtiva?.id === loja.id,
                  label: loja.environment === "live" ? nomeDaLoja(loja) : `${nomeDaLoja(loja)} (sandbox)`,
                })),
              ]}
            />

            <FormularioFiltro action="/anuncios/shopee" className="sb-an-busca" role="search">
              {/* Um GET nativo envia SÓ os campos do formulário: sem os
                  hidden, buscar descartaria a loja e o estado (D-136). */}
              {hidden("loja", filters.loja)}
              {hidden("estado", filters.estado)}
              <span className="sb-an-busca-icone" aria-hidden="true">
                <Icone nome="lupa" tamanho={14} />
              </span>
              <input
                type="search"
                name="q"
                className="sb-input"
                defaultValue={filters.busca ?? ""}
                placeholder="Nome, SKU ou item"
                aria-label="Buscar anúncio da Shopee por nome, SKU ou número do item"
              />
              <button type="submit" className="sb-button">
                Buscar
              </button>
            </FormularioFiltro>
          </>
        }
      />

      <section aria-label="Contadores dos anúncios da Shopee">
        <KpiStrip ancora cells={celulas} />
      </section>

      <div className="sb-an-lista">
        <Panel
          title="Anúncios e vínculos"
          subtitle={lista.error === null && !alemDoFim ? janela.label : undefined}
          aside={
            <FilterMenu
              rotulo={estadoAtivo?.rotulo ?? "Todos os vínculos"}
              opcoes={[
                {
                  href: buildShopeeListingsHref(filters, { estado: null }),
                  ativo: estadoAtivo === null,
                  label: "Todos os vínculos",
                },
                ...SHOPEE_LINK_STATES.map((estado) => ({
                  href: buildShopeeListingsHref(filters, { estado: estado.slug }),
                  ativo: estadoAtivo?.slug === estado.slug,
                  label: estado.rotulo,
                })),
              ]}
            />
          }
        >
          {chips.length > 0 && (
            <div className="sb-an-chips" aria-label="Filtros ativos">
              <span className="sb-an-chips-rotulo">Filtros ativos:</span>
              {chips.map((chip) => (
                <LinkDeFiltro key={chip.rotulo} className="sb-an-chip" href={chip.href} aria-label={`Tirar o filtro ${chip.rotulo}`}>
                  {chip.rotulo}
                  <span aria-hidden="true">×</span>
                </LinkDeFiltro>
              ))}
              <LinkDeFiltro className="sb-text-button sb-an-limpar" href={limpar}>
                Limpar filtros
              </LinkDeFiltro>
            </div>
          )}

          {lojasSemConexao.length > 0 && (rows.length > 0 || !leituraParada) && (
            // Loja do escopo que parou de ser lida: as linhas dela são as da
            // última leitura, e a tela diz isso em vez de calar. (Sem linha e
            // sem loja conectada, quem diz é o estado vazio, abaixo.)
            <p role="note" className="sb-an-nota">
              {lojasSemConexao.length === 1
                ? "A conexão desta loja está com erro e o catálogo dela não é relido até ela ser reconectada"
                : "A conexão destas lojas está com erro e o catálogo delas não é relido até serem reconectadas"}{" "}
              ({lojasSemConexao.map(nomeDaLoja).join(", ")}) — reconecte em <Link href="/contas">Contas</Link>.
            </p>
          )}

          {lista.error === null && ultimaLeitura === null && rows.length > 0 && !leituraParada && (
            // Itens já na lista e a leitura da loja ainda sem marco: a primeira
            // passada não terminou, e a lista ainda pode crescer.
            <p role="note" className="sb-an-nota">
              A primeira leitura completa do catálogo ainda não terminou; a lista cresce a cada leitura, de hora em
              hora.
            </p>
          )}

          {lista.error === null && rows.length > 0 && !podeVincular && (
            // Sem o papel, a coluna "Vínculo" não tem botão — a tela diz por quê.
            <p role="note" className="sb-an-nota">
              Vincular um anúncio à mão é para administrador, gestor ou operador da organização.
            </p>
          )}

          {lista.error !== null && (
            <Estado titulo="Não foi possível carregar os anúncios da Shopee." erro>
              <span>{sanitizeErrorText(lista.error.message) ?? "A leitura falhou neste carregamento."}</span>
              <LinkDeFiltro className="sb-button" href={buildShopeeListingsHref(filters, { pagina: filters.pagina })}>
                Tentar de novo
              </LinkDeFiltro>
            </Estado>
          )}

          {lista.error === null &&
            rows.length === 0 &&
            (filters.pagina > 1 ? (
              <Estado titulo="Esta página passou do fim da lista.">
                <LinkDeFiltro className="sb-button" href={buildShopeeListingsHref(filters, { pagina: 1 })}>
                  Voltar à primeira página
                </LinkDeFiltro>
              </Estado>
            ) : temFiltro ? (
              <Estado titulo="Nenhum anúncio corresponde a estes filtros.">
                <LinkDeFiltro className="sb-button" href={limpar}>
                  Limpar filtros
                </LinkDeFiltro>
              </Estado>
            ) : contagens === null ? (
              // Sem os contadores não se sabe se o catálogo já foi lido: a tela
              // não afirma nem "nunca lido" nem "lido e vazio".
              <Estado titulo="Nenhum anúncio na lista.">
                <span>Não foi possível conferir agora se o catálogo já foi lido.</span>
              </Estado>
            ) : ultimaLeitura === null ? (
              <Estado titulo="O catálogo da Shopee ainda não foi lido.">
                {leituraParada ? (
                  <>
                    <span>A conexão da loja está com erro, e a leitura só roda com a loja conectada.</span>
                    <Link className="sb-button" href="/contas">
                      Reconectar em Contas
                    </Link>
                  </>
                ) : (
                  <span>A primeira leitura acontece na próxima hora — o catálogo é lido de hora em hora.</span>
                )}
              </Estado>
            ) : (
              <Estado titulo={lojasNoEscopo.length > 1 ? "Nenhum anúncio nas lojas Shopee." : "Nenhum anúncio nesta loja."}>
                <span>A última leitura do catálogo não encontrou anúncio; itens apagados ficam de fora.</span>
              </Estado>
            ))}

          {lista.error === null && rows.length > 0 && (
            <div className="sb-an-rolagem">
              <table className="sb-table sb-an-tabela" aria-label="Anúncios da Shopee">
                <thead>
                  <tr>
                    <th>Anúncio</th>
                    <th>Loja</th>
                    <th title="O SKU que o vendedor digitou no anúncio: o da variação, ou o do item sem variação">
                      SKU do anúncio
                    </th>
                    <th title="O vínculo manual, gravado aqui, vence; sem ele vale o SKU do anúncio">Vínculo</th>
                    <th className="sb-num">Preço</th>
                    <th className="sb-num" title="Estoque disponível DO ANÚNCIO na Shopee — não o do ERP">
                      Estoque
                    </th>
                    <th>Status</th>
                  </tr>
                </thead>

                <tbody>
                  {rows.map((row) => {
                    const foto = shopeeImageUrl(row.image_url);
                    const estado = shopeeLinkState(row.estado);
                    const status = shopeeItemStatus(row.item_status);
                    const zerado = row.available_stock === 0;
                    const inativo = row.item_status !== "NORMAL";
                    const classes = [zerado ? "sb-an-linha-zerada" : "", inativo ? "sb-an-linha-inativa" : ""]
                      .filter((classe) => classe !== "")
                      .join(" ");
                    const acao = acaoDoVinculoShopee(row);
                    const indica = skuQueOAnuncioIndica(row);

                    return (
                      <tr
                        key={`${row.shopee_shop_id}:${String(row.item_id)}:${row.model_id === null ? "item" : String(row.model_id)}`}
                        className={classes === "" ? undefined : classes}
                      >
                        <td className="sb-an-produto">
                          <span className="sb-an-produto-linha">
                            {foto === null ? (
                              <span className="sb-product-thumb sb-an-foto" aria-hidden="true">
                                {monogramaDeProduto(row.item_name ?? "")}
                              </span>
                            ) : (
                              <img
                                className="sb-an-foto"
                                src={foto}
                                alt=""
                                width={40}
                                height={40}
                                loading="lazy"
                                decoding="async"
                                referrerPolicy="no-referrer"
                              />
                            )}
                            <span className="sb-an-produto-texto">
                              {row.item_name === null ? (
                                <span className="sb-an-titulo sb-an-suave">Nome ainda não lido</span>
                              ) : (
                                <span className="sb-an-titulo">{row.item_name}</span>
                              )}
                              {row.model_name !== null && <span className="sb-an-meta">{row.model_name}</span>}
                              <span className="sb-an-meta">
                                <span className="sb-mono" title="Número do item na Shopee">
                                  {row.item_id}
                                </span>
                                {row.model_id !== null && (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <span className="sb-mono" title="Número da variação na Shopee">
                                      variação {row.model_id}
                                    </span>
                                  </>
                                )}
                              </span>
                            </span>
                          </span>
                        </td>
                        <td data-label="Loja">{nomePorId.get(row.shopee_shop_id) ?? row.shop_name ?? "—"}</td>
                        <td data-label="SKU do anúncio">
                          {row.sku_anuncio === null ? "—" : <span className="sb-mono">{row.sku_anuncio}</span>}
                        </td>
                        <td data-label="Vínculo">
                          {row.estado === "VINCULADO" && row.sku_id !== null && row.sku !== null ? (
                            <>
                              <Link className="sb-entity sb-mono" href={`/skus/${row.sku_id}`} title={row.sku_title ?? undefined}>
                                {row.sku}
                              </Link>
                              <small className="sb-an-sub">
                                {row.vinculo_via === "MANUAL" ? "vínculo manual" : "pelo SKU do anúncio"}
                              </small>
                              {/* O manual vence, e quando ele discorda do anúncio a
                                  linha diz o que o anúncio indicaria. */}
                              {indica !== null && (
                                <small className="sb-an-sub">
                                  o anúncio indica <span className="sb-mono">{indica}</span>
                                </small>
                              )}
                            </>
                          ) : estado === null ? (
                            row.estado
                          ) : (
                            <>
                              <StatePill tone={{ tom: estado.tom, label: estado.rotulo }} />
                              <small className="sb-an-sub" title={estado.criterio}>
                                {estado.codigo === "AGUARDANDO_LEITURA"
                                  ? explicacaoDoAguardando(row.details_error, row.details_synced_at)
                                  : estado.explicacao}
                              </small>
                            </>
                          )}

                          {/* O VÍNCULO MANUAL (D-429): só para quem pode gravar. */}
                          {podeVincular && acao.tipo === "aguardando" && (
                            // A RPC recusaria: a unidade ainda não está no catálogo lido.
                            <small className="sb-an-sub">vincular à mão só depois da leitura</small>
                          )}
                          {podeVincular &&
                            (acao.tipo === "manual" || acao.tipo === "outro-sku" || acao.tipo === "vincular") && (
                              <AcoesDoVinculoShopee
                                modo={acao.tipo}
                                linkId={acao.tipo === "manual" ? acao.linkId : null}
                                unidade={{
                                  lojaId: row.shopee_shop_id,
                                  lojaNome: nomePorId.get(row.shopee_shop_id) ?? row.shop_name ?? "Loja Shopee",
                                  itemId: row.item_id,
                                  modelId: row.model_id,
                                  itemName: row.item_name,
                                  modelName: row.model_name,
                                  skuAnuncio: row.sku_anuncio,
                                  skuAtual:
                                    row.estado === "VINCULADO" && row.sku_id !== null && row.sku !== null
                                      ? { id: row.sku_id, sku: row.sku }
                                      : null,
                                  skuPeloAnuncio: row.sku_pelo_anuncio,
                                }}
                              />
                            )}
                        </td>
                        {/* Ausente é "—", nunca zero (D-067): o item ainda não
                            lido não tem preço nem estoque. O preço original
                            riscado só quando a Shopee o deu MAIOR que o atual. */}
                        <td className="sb-num" data-label="Preço">
                          {row.original_price !== null &&
                          row.current_price !== null &&
                          row.original_price > row.current_price ? (
                            <span className="sb-an-preco-promo">
                              {formatShopeeMoney(row.current_price, row.currency)}
                              <s className="sb-an-preco-de">{formatShopeeMoney(row.original_price, row.currency)}</s>
                            </span>
                          ) : (
                            formatShopeeMoney(row.current_price, row.currency)
                          )}
                        </td>
                        <td className="sb-num" data-label="Estoque">
                          {row.available_stock === null ? (
                            "—"
                          ) : zerado ? (
                            <span className="sb-an-zerado">0</span>
                          ) : (
                            formatCount(row.available_stock)
                          )}
                        </td>
                        <td data-label="Status">
                          <StatePill tone={{ tom: status.tom, label: status.rotulo }} />
                          {shopeeModelUnavailable(row.model_status) && (
                            <small className="sb-an-sub">variação indisponível</small>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {lista.error === null && janela.totalPages > 1 && (
            <nav className="sb-an-paginacao" aria-label="Paginação dos anúncios da Shopee">
              <span className="sb-an-suave">{janela.label}</span>
              <div className="sb-an-paginas">
                {filters.pagina > 1 ? (
                  <LinkDeFiltro className="sb-button" href={buildShopeeListingsHref(filters, { pagina: filters.pagina - 1 })}>
                    ‹ Anterior
                  </LinkDeFiltro>
                ) : (
                  <span className="sb-button" aria-disabled="true">
                    ‹ Anterior
                  </span>
                )}
                {pageNumbers(filters.pagina, janela.totalPages).map((numeroDaPagina, indice) =>
                  numeroDaPagina === "…" ? (
                    <span key={`salto-${String(indice)}`} className="sb-an-salto" aria-hidden="true">
                      …
                    </span>
                  ) : (
                    <LinkDeFiltro
                      key={numeroDaPagina}
                      className={numeroDaPagina === filters.pagina ? "sb-an-pagina sb-an-pagina-atual" : "sb-an-pagina"}
                      href={buildShopeeListingsHref(filters, { pagina: numeroDaPagina })}
                      aria-current={numeroDaPagina === filters.pagina ? "page" : undefined}
                      aria-label={`Página ${String(numeroDaPagina)}`}
                    >
                      {formatCount(numeroDaPagina)}
                    </LinkDeFiltro>
                  ),
                )}
                {filters.pagina < janela.totalPages ? (
                  <LinkDeFiltro className="sb-button" href={buildShopeeListingsHref(filters, { pagina: filters.pagina + 1 })}>
                    Próxima ›
                  </LinkDeFiltro>
                ) : (
                  <span className="sb-button" aria-disabled="true">
                    Próxima ›
                  </span>
                )}
              </div>
            </nav>
          )}
        </Panel>
      </div>
    </Shell>
  );
}
