import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { toneColor } from "../../components/state-pill";
import { formatDateTime } from "../../lib/format";
import { mlAccountStatusLabel, statusTone } from "../../lib/labels";
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
 */

export default async function ContasPage(): Promise<ReactNode> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("ml_accounts")
    .select("id, label, slug, status, seller_id, connected_at, last_error")
    .order("label", { ascending: true });

  const accounts = data ?? [];

  return (
    <Shell>
      <h1 style={{ margin: "0 0 var(--sb-space-1)", fontSize: "1.375rem" }}>Contas Mercado Livre</h1>

      <p style={{ margin: "0 0 var(--sb-space-4)", color: "var(--sb-text-soft)", fontSize: "0.9375rem" }}>
        Cadastre a conta e clique em Conectar — você vai logar no Mercado Livre como administrador
        daquela loja específica. Depois de conectada, ninguém mais precisa reautenticar; o backfill
        de história começa sozinho.
      </p>

      <NewAccountForm />

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar as contas: {sanitizeErrorText(error.message)}
        </p>
      )}

      {error === null && accounts.length === 0 && (
        <p style={{ color: "var(--sb-text-soft)" }}>Nenhuma conta cadastrada ainda.</p>
      )}

      {accounts.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "var(--sb-space-2)" }}>
          {accounts.map((account) => {
            // Rótulo e tom do vocabulário único (D-232) — este mapa vivia copiado aqui,
            // em /sincronizacao e em /integracoes.
            const tone = { color: toneColor(statusTone(account.status)), label: mlAccountStatusLabel(account.status) };

            return (
              <li
                key={account.id}
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: "var(--sb-space-3)",
                  padding: "var(--sb-space-3)",
                  border: "1px solid var(--sb-border)",
                  borderRadius: "var(--sb-radius)",
                  borderLeft: `3px solid ${tone.color}`,
                  background: "var(--sb-surface)",
                }}
              >
                <span style={{ fontWeight: 600, minWidth: "10rem" }}>{account.label}</span>

                <span
                  style={{ color: "var(--sb-text-soft)", fontSize: "0.8125rem", fontFamily: "ui-monospace, monospace" }}
                >
                  {account.slug}
                </span>

                <span style={{ fontSize: "0.8125rem", fontWeight: 700, color: tone.color }}>{tone.label}</span>

                {account.status === "CONNECTED" && (
                  <span style={{ color: "var(--sb-text-soft)", fontSize: "0.8125rem" }}>
                    seller_id {account.seller_id} · desde {formatDateTime(account.connected_at)}
                  </span>
                )}

                {account.status === "ERROR" && account.last_error !== null && (
                  // Sanitizado (D-232): a Central oculta este mesmo texto e aponta para
                  // cá — a "última linha antes da tela" tem de ser a mesma nas duas.
                  <span style={{ color: "var(--sb-danger)", fontSize: "0.8125rem" }}>
                    {sanitizeErrorText(account.last_error)}
                  </span>
                )}

                <span style={{ marginLeft: "auto" }}>
                  {account.status !== "CONNECTED" && (
                    <ConnectButton mlAccountId={account.id} label={account.label} />
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Shell>
  );
}
