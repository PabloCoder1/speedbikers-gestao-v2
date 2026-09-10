import Link from "next/link";
import type { ReactNode } from "react";

import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { StatePill } from "../../components/state-pill";
import { TOM, tomDeStatus } from "../../components/tone";
import { formatCount, formatDateTime } from "../../lib/format";
import { mlAccountStatusLabel, statusTone } from "../../lib/labels";
import { currentMembership } from "../../lib/membership";
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

  const membership = await currentMembership(supabase);
  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <Shell>
        <PageTitle eyebrow="ADMINISTRAÇÃO / CANAIS E PARCEIROS" title="Contas Mercado Livre" compacto />
        <p className="sb-empty">Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const { data, error } = await supabase.rpc("get_ml_account_cards", {
    p_organization_id: organizationId,
  });

  const accounts = data ?? [];

  const agora = new Date();

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
      />

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar as contas: {sanitizeErrorText(error.message)}
        </p>
      )}

      {error === null && accounts.length === 0 && (
        <p className="sb-empty">Nenhuma conta cadastrada ainda.</p>
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
                    <span className="sb-mono" style={{ fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>
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
                  <p
                    role="alert"
                    style={{
                      ...TOM.perigo,
                      margin: "var(--sb-space-2) 0 0",
                      padding: "var(--sb-space-2)",
                      borderRadius: "var(--sb-radius)",
                      fontSize: "0.6875rem",
                      lineHeight: 1.5,
                    }}
                  >
                    Token vencido numa conta conectada — a renovação automática parou. As sincronizações
                    desta conta vão falhar até ela ser reautorizada.
                  </p>
                )}

                {account.status === "ERROR" && account.last_error !== null && (
                  // Sanitizado (D-232): a Central oculta este mesmo texto e aponta para
                  // cá — a "última linha antes da tela" tem de ser a mesma nas duas.
                  <p
                    style={{
                      margin: "var(--sb-space-2) 0 0",
                      color: "var(--sb-danger)",
                      fontSize: "0.6875rem",
                      lineHeight: 1.5,
                    }}
                  >
                    {sanitizeErrorText(account.last_error)}
                  </p>
                )}

                <footer>
                  {/* O "Ver saúde da conta →" do frame, apontando para a tela
                      DONA do frescor por conta (D-224: um dado, um dono). */}
                  <Link
                    href="/sincronizacao"
                    style={{ fontSize: "0.6875rem", color: "var(--sb-secondary)", textDecoration: "none" }}
                  >
                    Ver saúde da conta →
                  </Link>

                  {!conectada && <ConnectButton mlAccountId={account.id} label={account.label} />}
                </footer>
              </section>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: "var(--sb-space-3)" }}>
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
