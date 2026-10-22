import Link from "next/link";
import type { ReactNode } from "react";

import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { StatePill } from "../../../components/state-pill";
import { Icone } from "../../../components/icons";
import { KpiStrip } from "../../../components/kpi-strip";
import { TOM, tomDeStatus } from "../../../components/tone";
import { EstadoDaTela, TENTAR_DE_NOVO } from "../../../components/estado-da-tela";
import { autorizacaoVencendo, celulasDeContasELojas, type LojasTiktokDaFaixa } from "../../../lib/contas-e-lojas";
import { formatCount, formatDateTime } from "../../../lib/format";
import { mlAccountStatusLabel, statusTone } from "../../../lib/labels";
import { currentMembership } from "../../../lib/request-membership";
import { formatAge } from "../../../lib/relative-time";
import { sanitizeErrorText } from "../../../lib/sanitize";
import { isShopeeSchemaMissing, resumoDoCatalogoShopee } from "../../../lib/shopee-listings";
import { createClient } from "../../../lib/supabase/server";
import { ConnectButton } from "./connect-button";
import { NewAccountForm } from "./new-account-form";
import { ShopeeConnectButton } from "./shopee-connect-button";
import { TiktokConnectButton } from "./tiktok-connect-button";

export const metadata = { title: "Contas e lojas — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Ver apps/web/app/(app)/importacoes/page.tsx para o mesmo raciocínio.
export const dynamic = "force-dynamic";

/**
 * Contas e lojas — cadastro e conexão OAuth das contas do Mercado Livre e das
 * lojas Shopee (D-425). O título fala dos dois canais desde D-431: a tela já
 * conectava a Shopee, mas o nome e o menu só falavam do Mercado Livre.
 *
 * Pendência registrada em `docs/HANDOFF.md` desde a Fase 3: a rota
 * `POST /v1/ml-accounts/connect` existia e estava testada, mas sem tela
 * nenhuma para chegar até ela. Esta página fecha essa lacuna.
 *
 * Criar a conta (`ml_accounts`) é escrita direta sob RLS — só ADMIN, sem
 * segredo. Conectar exige o `client_secret` do Mercado Livre, que só a `api`
 * conhece — por isso é uma chamada separada (`connect-button.tsx`).
 *
 * ---------------------------------------------------------------------------
 * Refeita contra o frame `Accounts` (D-299, fatia A8)
 * ---------------------------------------------------------------------------
 *
 * A tela era uma LISTA de linhas. O frame desenha dois cartões por linha, e
 * cada cartão carrega três linhas de detalhe que a lista não tinha onde pôr:
 * última sincronização, anúncios sincronizados e permissões. **As três têm
 * fonte real** — `sync_runs`, `listings` e `ml_credentials.scopes` —, e é por
 * isso que a composição mudou: mudou a quantidade de dado, não o gosto.
 *
 * O `ml_credentials` tem RLS ligada com ZERO policies e ZERO grants para a
 * web: cofre de token não se lê do navegador. Os dois derivados chegam por
 * `get_ml_account_cards`, `security definer`, que não devolve um único campo
 * cifrado — o raciocínio inteiro está na migration.
 */

export default async function ContasPage(): Promise<ReactNode> {
  const supabase = await createClient();

  const membership = await currentMembership();
  const organizationId = membership.organizationId;
  // Conectar e reconectar são só ADMIN na api (`POST /v1/ml-accounts/connect`)
  // e cadastrar conta é só ADMIN na RLS: os outros papéis não veem os botões.
  const ehAdmin = membership.role === "ADMIN";

  if (organizationId === null) {
    return (
      <>
        <PageTitle eyebrow="ADMINISTRAÇÃO / CANAIS E PARCEIROS" title="Contas e lojas" compacto />
        <Panel title="Acesso indisponível">
          <EstadoDaTela
            tipo="permissao"
            titulo="Sua conta ainda não pertence a uma organização."
            descricao="Peça a um administrador para concluir o vínculo antes de gerenciar contas do Mercado Livre."
          />
        </Panel>
      </>
    );
  }

  // D-425: as lojas Shopee saem na mesma ida das contas do Mercado Livre.
  // D-429: e o tamanho do catálogo de cada loja também — contado no SQL
  // (`get_shopee_shop_catalog_counts`), nulo quando o catálogo nunca foi lido.
  // D-652 (C-86): e as lojas do TikTok Shop, pela RLS de membro. A tabela chega com a
  // migration `20261022170000`; antes dela, a leitura volta PGRST205 e o painel diz que
  // o canal chega com a próxima atualização do banco, sem erro.
  const [{ data, error }, lojasShopee, catalogoShopee, lojasTiktok] = await Promise.all([
    supabase.rpc("get_ml_account_cards", { p_organization_id: organizationId }),
    supabase
      .from("shopee_shops")
      .select("id, shop_id, shop_name, region, environment, status, shop_status, auth_expires_at, connected_at, last_error")
      .order("connected_at", { ascending: true }),
    supabase.rpc("get_shopee_shop_catalog_counts", { p_organization_id: organizationId }),
    supabase
      .from("tiktok_shops")
      .select("id, shop_id, shop_name, region, seller_type, seller_name, granted_scopes, status, last_error, connected_at, auth_expires_at")
      .order("connected_at", { ascending: true }),
  ]);

  const accounts = data ?? [];
  // Por loja, para a coluna "Anúncios": indexar o que o banco já contou, não somar.
  const catalogoPorLoja = new Map((catalogoShopee.data ?? []).map((linha) => [linha.shopee_shop_id, linha]));
  const catalogoAusente = isShopeeSchemaMissing(catalogoShopee.error);

  const agora = new Date();
  // D-600: a faixa conta as contas do ML E as lojas Shopee, com a divisão ao lado do
  // número; as lojas que não carregaram não viram zero.
  const tiktokAusente = lojasTiktok.error !== null && (lojasTiktok.error.code === "PGRST205" || lojasTiktok.error.code === "42P01");
  const tiktokDaFaixa: LojasTiktokDaFaixa =
    lojasTiktok.error === null ? { estado: "lidas", lojas: lojasTiktok.data } : tiktokAusente ? { estado: "ausente" } : { estado: "falhou" };
  const faixa = celulasDeContasELojas(accounts, lojasShopee.error === null ? lojasShopee.data : null, agora, tiktokDaFaixa);

  return (
    <>
      {/* A sobrancelha é a que `/integracoes` já usa (D-272): as duas telas
          respondem pelo mesmo grupo, e o frame põe "COMERCIAL / INTEGRAÇÕES"
          aqui — mas a navegação real desta tela mora em ADMINISTRAÇÃO, e a
          sobrancelha existe para concordar com a sidebar acesa. */}
      <PageTitle
        eyebrow="ADMINISTRAÇÃO / CANAIS E PARCEIROS"
        title="Contas e lojas"
        subtitle="Mercado Livre, Shopee e TikTok Shop: conexões, permissões e disponibilidade de dados por operação."
        compacto
        aside={
          <nav className="sb-channel-nav" aria-label="Navegação de canais">
            <Link href="/integracoes">Mapa de integrações →</Link>
            <Link href="/sincronizacao">Saúde da sincronização →</Link>
          </nav>
        }
      />

      <section className="sb-channel-hero sb-channel-hero-accounts" aria-labelledby="contas-hero-title">
        <div className="sb-channel-hero-copy">
          <span className="sb-channel-hero-kicker">CENTRAL DE CANAIS</span>
          <h2 id="contas-hero-title">Toda loja conectada, com o pulso da operação à vista.</h2>
          <p>Veja rapidamente o que está conectado, o que foi sincronizado e onde uma reautorização pode destravar o fluxo.</p>
        </div>
        <div className="sb-channel-hero-flow" aria-label="Fluxo da conta Mercado Livre">
          <span><Icone nome="tomada" tamanho={17} /> Conectar</span>
          <i aria-hidden="true">→</i>
          <span><Icone nome="pulso" tamanho={17} /> Sincronizar</span>
          <i aria-hidden="true">→</i>
          <span><Icone nome="tendencia" tamanho={17} /> Operar</span>
        </div>
      </section>

      <KpiStrip cells={faixa} />

      {error !== null && (
        <EstadoDaTela
          tipo="erro"
          titulo="Não foi possível carregar as contas agora."
          descricao="A leitura falhou neste carregamento."
          detalhe={error.message}
          acao={{ href: "/contas", rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
        />
      )}

      {error === null && accounts.length === 0 && (
        <div className="sb-panel">
          <EstadoDaTela
            tipo="vazio"
            titulo="Nenhuma conta cadastrada ainda."
            descricao="Cadastre o identificador da loja abaixo e conclua o login no Mercado Livre para iniciar as sincronizações."
          />
        </div>
      )}

      {accounts.length > 0 && (
        <div className="sb-account-cards">
          {accounts.map((account) => {
            // Rótulo e tom do vocabulário único (D-232) — este mapa vivia copiado aqui,
            // em /sincronizacao e em /integracoes.
            const tone = {
              tom: tomDeStatus(statusTone(account.status)),
              label: mlAccountStatusLabel(account.status),
            };

            const conectada = account.status === "CONNECTED";

            /*
              A CREDENCIAL, e por que aqui NÃO há contagem regressiva.

              O frame escreve "Token expira em 2 dias". Medido no Dev: o token
              do Mercado Livre vive **6,0 horas** nas quatro contas, e o worker
              renova o dia inteiro — as credenciais tinham 1,7 a 4,5 h de vida
              quando medi. Uma contagem regressiva estaria sempre em "expira em
              poucas horas", ou seja, alarme permanente numa operação saudável.

              O que a expiração diz de verdade é o caso raro: token VENCIDO numa
              conta conectada significa que a renovação parou. Só isso vira
              aviso; o resto é "atualizada há X", que mostra o ciclo vivo.
            */
            // "atualizada", nao "renovada": a coluna e `updated_at`, e QUALQUER
            // escrita na linha a move -- inclusive uma tentativa de renovacao
            // que FALHOU e so gravou `refresh_locked_until`. Chamar de
            // "renovada" afirmaria um sucesso que o carimbo nao garante, e a
            // tela mostrou o problema: com o token vencido de proposito, ela
            // dizia "renovada agora ha pouco" ao lado de "token vencido".
            const atualizada = formatAge(account.credential_updated_at, agora);
            const credencialParada = conectada && account.token_expired === true;

            return (
              <section className="sb-account-card" key={account.id} aria-label={account.label}>
                <div className="sb-account-head">
                  <span className="sb-account-logo" aria-hidden="true">
                    ML
                  </span>

                  <div>
                    <h2>{account.label}</h2>
                    <span className="sb-mono sb-account-meta">
                      {account.seller_id === null ? account.slug : `${account.slug} · ${String(account.seller_id)}`}
                    </span>
                  </div>

                  <StatePill tone={tone} />
                </div>

                <p className="sb-account-link">
                  <span
                    className="sb-account-dot"
                    style={{ ["--sb-tone" as string]: TOM[tone.tom].color }}
                    aria-hidden="true"
                  />
                  {conectada
                    ? `Mercado Livre conectado${account.connected_at === null ? "" : ` desde ${formatDateTime(account.connected_at)}`}`
                    : "Sem conexão ativa com o Mercado Livre"}
                </p>

                <dl>
                  <div>
                    <dt>Última sincronização</dt>
                    <dd>
                      {account.last_sync_at === null
                        ? "nenhuma concluída"
                        : (formatAge(account.last_sync_at, agora) ?? formatDateTime(account.last_sync_at))}
                    </dd>
                  </div>

                  <div>
                    <dt>Anúncios sincronizados</dt>
                    <dd>{formatCount(account.listings_count)}</dd>
                  </div>

                  <div>
                    <dt>Permissões</dt>
                    {/*
                      O frame escreve "Todas as permissões". CONTAR é o que dá
                      para afirmar: "todas" exigiria uma lista canônica do que
                      o Mercado Livre oferece, que ninguém definiu — e um
                      escopo a menos apareceria como "todas" do mesmo jeito.
                    */}
                    <dd>
                      {account.scope_count === null
                        ? "sem credencial"
                        : `${formatCount(account.scope_count)} escopo(s)`}
                    </dd>
                  </div>

                  {atualizada !== null && (
                    <div>
                      <dt>Credencial atualizada</dt>
                      <dd>{atualizada}</dd>
                    </div>
                  )}
                </dl>

                {credencialParada && (
                  <p role="alert" className="sb-account-warning" style={TOM.perigo}>
                    Token vencido numa conta conectada — a renovação automática parou. As sincronizações
                    desta conta vão falhar até ela ser reautorizada.
                  </p>
                )}

                {account.status === "ERROR" && account.last_error !== null && (
                  // Sanitizado (D-232): a Central oculta este mesmo texto e aponta para
                  // cá — a "última linha antes da tela" tem de ser a mesma nas duas.
                  <p className="sb-account-error">
                    {sanitizeErrorText(account.last_error)}
                  </p>
                )}

                <footer>
                  {/* O "Ver saúde da conta →" do frame, apontando para a tela
                      DONA do frescor por conta (D-224: um dado, um dono). */}
                  <Link href="/sincronizacao" className="sb-account-health-link">
                    Ver saúde da conta →
                  </Link>

                  {ehAdmin && !conectada && <ConnectButton mlAccountId={account.id} label={account.label} />}
                  {/* O aviso de token vencido pedia reautorização e não havia
                      botão: ele só existia para conta desconectada (lote 1 do
                      pente fino, 18/09). A api aceita reautorizar SÓ esta conta
                      parada, e só com o mesmo usuário do Mercado Livre. */}
                  {ehAdmin && credencialParada && (
                    <ConnectButton mlAccountId={account.id} label={account.label} reconectar />
                  )}
                </footer>
              </section>
            );
          })}
        </div>
      )}

      {/*
        SHOPEE (D-425): segundo canal, só leitura. A loja nasce no retorno da
        autorização — não há cadastro antes, como no Mercado Livre. Sem a
        tabela (banco anterior a 20261013120000), o painel diz que a novidade
        ainda não chegou em vez de virar erro.
      */}
      <div className="sb-account-create">
        <Panel
          title="Lojas Shopee"
          subtitle="Conecte a loja e autorize na Shopee com o login da própria loja. A Shopee pede a autorização de novo no prazo escolhido nela (até 365 dias)."
        >
          <div className="sb-panel-body">
            {lojasShopee.error !== null ? (
              <p className="sb-empty">
                {lojasShopee.error.code === "PGRST205" || lojasShopee.error.code === "42P01"
                  ? "As lojas Shopee chegam com a próxima atualização do banco."
                  : `Não foi possível ler as lojas Shopee: ${lojasShopee.error.message}`}
              </p>
            ) : lojasShopee.data.length === 0 ? (
              <p className="sb-empty">Nenhuma loja Shopee conectada ainda.</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="sb-table" aria-label="Lojas Shopee">
                  <thead>
                    <tr>
                      <th>Loja</th>
                      <th>Ambiente</th>
                      <th>Conexão</th>
                      <th title="Unidades de anúncio (cada variação, ou o item sem variação) e quantas têm SKU vinculado — manual ou pelo SKU do anúncio; itens apagados ficam de fora">
                        Anúncios
                      </th>
                      <th>Autorização vence</th>
                      <th>Conectada em</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lojasShopee.data.map((loja) => {
                      const catalogo = catalogoPorLoja.get(loja.id) ?? null;
                      const resumo =
                        catalogo === null ? null : resumoDoCatalogoShopee(catalogo.anuncios, catalogo.vinculados);
                      const ultimaLeitura = catalogo?.ultima_leitura ?? null;

                      return (
                        <tr key={loja.id}>
                          <td>
                            {loja.shop_name ?? "Loja sem nome lido"}
                            <span className="sb-mono" style={{ display: "block", color: "var(--sb-text-soft)" }}>
                              {loja.shop_id}
                              {loja.region === null ? "" : ` · ${loja.region}`}
                              {loja.shop_status === null || loja.shop_status === "NORMAL" ? "" : ` · ${loja.shop_status}`}
                            </span>
                          </td>
                          <td>{loja.environment === "live" ? "Produção" : "Teste (sandbox)"}</td>
                          <td>
                            {loja.status === "CONNECTED" ? "Conectada" : "Com erro"}
                            {loja.last_error === null ? null : (
                              <span style={{ display: "block", color: "var(--sb-text-soft)" }}>
                                {sanitizeErrorText(loja.last_error)}
                              </span>
                            )}
                          </td>
                          {/*
                            O CATÁLOGO DA LOJA (D-429): contado no SQL; nulo é
                            "—", nunca zero (D-067) — "0 anúncios" afirmaria uma
                            loja vazia que ninguém leu. O número leva à lista
                            da loja em Anúncios da Shopee.
                          */}
                          <td>
                            {resumo === null ? "—" : <Link href={`/anuncios/shopee?loja=${loja.id}`}>{resumo}</Link>}
                            <span style={{ display: "block", color: "var(--sb-text-soft)" }}>
                              {catalogoShopee.error !== null
                                ? catalogoAusente
                                  ? "chega com a próxima atualização do banco"
                                  : "não foi possível ler agora"
                                : ultimaLeitura === null
                                  ? "catálogo ainda não lido"
                                  : `lido ${formatAge(ultimaLeitura, agora) ?? `em ${formatDateTime(ultimaLeitura)}`}`}
                            </span>
                          </td>
                          <td>
                            {loja.auth_expires_at === null ? "—" : formatDateTime(loja.auth_expires_at)}
                            {/* D-600: a leitura para quando a autorização vence; a faixa conta esta loja em "Requerem atenção". */}
                            {autorizacaoVencendo(loja, agora) && (
                              <span style={{ display: "block", color: "var(--sb-accent-ink)" }}>reautorize na Shopee: vence em até 7 dias</span>
                            )}
                          </td>
                          <td>{formatDateTime(loja.connected_at)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {ehAdmin && <ShopeeConnectButton />}
          </div>
        </Panel>
      </div>

      {/*
        AS LOJAS DO TIKTOK SHOP (D-652, o C-86 do A1, D-645). A fatia 1 do
        TikTok só conecta: a loja não traz pedido nem venda, e nada dela entra
        em tela nenhuma nem nos totais -- o subtítulo diz isso, para a loja
        conectada não parecer quebrada. O retorno da autorização para no JSON
        da api, como no ML e na Shopee: a dica embaixo do botão manda voltar.
        Até a api ter as variáveis do app, o botão recebe 503 e diz que o TikTok
        ainda não está disponível, sem erro.
      */}
      <div className="sb-account-create">
        <Panel
          title="Lojas do TikTok Shop"
          subtitle="Conecte a loja e autorize no TikTok Shop com o login do vendedor. Por enquanto a V3 guarda só a conexão: os pedidos e as vendas do TikTok ainda não entram em nenhuma tela nem nos totais."
        >
          <div className="sb-panel-body">
            {lojasTiktok.error !== null ? (
              <p className="sb-empty">
                {tiktokAusente
                  ? "As lojas do TikTok Shop chegam com a próxima atualização do banco."
                  : `Não foi possível ler as lojas do TikTok Shop: ${lojasTiktok.error.message}`}
              </p>
            ) : lojasTiktok.data.length === 0 ? (
              <p className="sb-empty">Nenhuma loja do TikTok Shop conectada ainda.</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="sb-table" aria-label="Lojas do TikTok Shop">
                  <thead>
                    <tr>
                      <th>Loja</th>
                      <th>Vendedor</th>
                      <th>Conexão</th>
                      <th>Permissões</th>
                      <th>Autorização vence</th>
                      <th>Conectada em</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lojasTiktok.data.map((loja) => (
                      <tr key={loja.id}>
                        <td>
                          {loja.shop_name ?? "Loja sem nome lido"}
                          <span className="sb-mono" style={{ display: "block", color: "var(--sb-text-soft)" }}>
                            {loja.shop_id}
                            {loja.region === null ? "" : ` · ${loja.region}`}
                          </span>
                        </td>
                        <td>
                          {loja.seller_name ?? "—"}
                          {loja.seller_type !== null && (
                            <span style={{ display: "block", color: "var(--sb-text-soft)" }}>{loja.seller_type}</span>
                          )}
                        </td>
                        <td>
                          {loja.status === "CONNECTED" ? "Conectada" : "Com erro"}
                          {loja.last_error === null ? null : (
                            <span style={{ display: "block", color: "var(--sb-text-soft)" }}>
                              {sanitizeErrorText(loja.last_error)}
                            </span>
                          )}
                        </td>
                        {/* As permissões que o vendedor concedeu; a lista inteira no `title`. Nulo é "—", nunca zero. */}
                        <td title={loja.granted_scopes === null ? undefined : loja.granted_scopes.join(", ")}>
                          {loja.granted_scopes === null
                            ? "—"
                            : loja.granted_scopes.length === 1
                              ? "1 permissão"
                              : `${formatCount(loja.granted_scopes.length)} permissões`}
                        </td>
                        <td>
                          {loja.auth_expires_at === null ? "—" : formatDateTime(loja.auth_expires_at)}
                          {autorizacaoVencendo(loja, agora) && (
                            <span style={{ display: "block", color: "var(--sb-accent-ink)" }}>
                              reautorize no TikTok Shop: vence em até 7 dias
                            </span>
                          )}
                        </td>
                        <td>{formatDateTime(loja.connected_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {ehAdmin && !tiktokAusente && (
              <>
                <TiktokConnectButton />
                <p className="sb-account-connect-note">Depois de autorizar no TikTok Shop, volte para esta tela: a loja aparece aqui.</p>
              </>
            )}
          </div>
        </Panel>
      </div>

      {ehAdmin && (
        <div className="sb-account-create">
          <Panel
            title="Conectar conta"
            subtitle="Cadastre a conta e clique em Conectar — você vai logar no Mercado Livre como administrador daquela loja específica. Depois de conectada, ninguém mais precisa reautenticar; o backfill de história começa sozinho."
          >
            <div className="sb-panel-body">
              <NewAccountForm />
            </div>
          </Panel>
        </div>
      )}
    </>
  );
}
