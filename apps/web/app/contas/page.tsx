import Link from "next/link";
import type { ReactNode } from "react";

import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { StatePill } from "../../components/state-pill";
import { Icone } from "../../components/icons";
import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { TOM, tomDeStatus } from "../../components/tone";
import { formatCount, formatDateTime } from "../../lib/format";
import { mlAccountStatusLabel, statusTone } from "../../lib/labels";
import { currentMembership } from "../../lib/request-membership";
import { formatAge } from "../../lib/relative-time";
import { sanitizeErrorText } from "../../lib/sanitize";
import { createClient } from "../../lib/supabase/server";
import { ConnectButton } from "./connect-button";
import { NewAccountForm } from "./new-account-form";

export const metadata = { title: "Contas Mercado Livre — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Ver apps/web/app/importacoes/page.tsx para o mesmo raciocínio.
export const dynamic = "force-dynamic";

/**
 * Contas Mercado Livre — cadastro e conexão OAuth.
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

  if (organizationId === null) {
    return (
      <Shell>
        <PageTitle eyebrow="ADMINISTRAÇÃO / CANAIS E PARCEIROS" title="Contas Mercado Livre" compacto />
        <Panel title="Acesso indisponível">
          <div className="sb-channel-empty">
            <span className="sb-channel-empty-icon" aria-hidden="true">
              <Icone nome="etiqueta" tamanho={20} />
            </span>
            <div>
              <strong>Sua conta ainda não pertence a uma organização.</strong>
              <p>Peça a um administrador para concluir o vínculo antes de gerenciar contas do Mercado Livre.</p>
            </div>
          </div>
        </Panel>
      </Shell>
    );
  }

  const { data, error } = await supabase.rpc("get_ml_account_cards", {
    p_organization_id: organizationId,
  });

  const accounts = data ?? [];

  const agora = new Date();
  const connectedCount = accounts.filter((account) => account.status === "CONNECTED").length;
  const attentionCount = accounts.filter((account) => account.status === "PENDING").length;
  const errorCount = accounts.filter((account) => account.status === "ERROR" || account.status === "REVOKED").length;
  const accountKpis: KpiCellData[] = [
    {
      label: "Contas cadastradas",
      formula: "Contas Mercado Livre visíveis para esta organização.",
      value: formatCount(accounts.length),
      previous: null,
      tom: "neutro",
    },
    {
      label: "Conectadas",
      formula: "Contas com autorização CONNECTED registrada.",
      value: formatCount(connectedCount),
      previous: null,
      tom: "neutro",
    },
    {
      label: "Aguardando conexão",
      formula: "Contas cadastradas que ainda precisam concluir o OAuth.",
      value: formatCount(attentionCount),
      previous: null,
      tom: "neutro",
    },
    {
      label: "Requerem atenção",
      formula: "Contas em ERROR ou REVOKED que precisam de nova verificação humana.",
      value: formatCount(errorCount),
      previous: null,
      tom: "neutro",
    },
  ];

  return (
    <Shell>
      {/* A sobrancelha é a que `/integracoes` já usa (D-272): as duas telas
          respondem pelo mesmo grupo, e o frame põe "COMERCIAL / INTEGRAÇÕES"
          aqui — mas a navegação real desta tela mora em ADMINISTRAÇÃO, e a
          sobrancelha existe para concordar com a sidebar acesa. */}
      <PageTitle
        eyebrow="ADMINISTRAÇÃO / CANAIS E PARCEIROS"
        title="Contas Mercado Livre"
        subtitle="Conexões, permissões e disponibilidade de dados por operação."
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

      <KpiStrip cells={accountKpis} />

      {error !== null && (
        <div className="sb-channel-error" role="alert">
          <span className="sb-channel-error-icon" aria-hidden="true">
            <Icone nome="pulso" tamanho={18} />
          </span>
          <div>
            <strong>Não foi possível carregar as contas agora.</strong>
            <p>{sanitizeErrorText(error.message) ?? "A leitura falhou neste carregamento."}</p>
          </div>
        </div>
      )}

      {error === null && accounts.length === 0 && (
        <div className="sb-channel-empty sb-channel-empty-panel">
          <span className="sb-channel-empty-icon" aria-hidden="true">
            <Icone nome="etiqueta" tamanho={20} />
          </span>
          <div>
            <strong>Nenhuma conta cadastrada ainda.</strong>
            <p>Cadastre o identificador da loja abaixo e conclua o login no Mercado Livre para iniciar as sincronizações.</p>
          </div>
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

                  {!conectada && <ConnectButton mlAccountId={account.id} label={account.label} />}
                </footer>
              </section>
            );
          })}
        </div>
      )}

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
    </Shell>
  );
}
