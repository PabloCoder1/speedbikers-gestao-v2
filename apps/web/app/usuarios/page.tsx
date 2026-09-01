import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { formatDateTime } from "../../lib/format";
import { createClient } from "../../lib/supabase/server";
import { AccountAccessControls, RoleSelect } from "./member-controls";

export const metadata = { title: "Usuários — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/**
 * Administração de Usuários e Permissões (D-175, trilha 8A).
 *
 * A tela é a parte MENOS importante desta fatia, e isso é de propósito. O
 * item nomeia "segurança apenas visual" como risco, então a autorização vive
 * inteira no banco:
 *
 * - quem pode escrever: as policies `*_admin_writes`, que já existiam;
 * - o que não pode acontecer nunca: o trigger `guard_last_admin`, que impede
 *   a organização de ficar sem ADMIN por qualquer caminho de escrita;
 * - o que aconteceu: `organization_access_events`, append-only, gravado pelo
 *   próprio banco.
 *
 * Esconder os controles de quem não é ADMIN é conveniência. Se alguém chamar
 * a Server Action direto, a policy recusa igual.
 *
 * **Convite/ativação de usuário novo NÃO entra aqui**: criar conta exige a
 * Admin API do Auth com `service_role` (a `web` não tem, e não deve ter — a
 * chave viveria no processo que serve a interface). Isso é rota da `api` com
 * decisão de produto própria (quem convida, e-mail, expiração), e inventá-la
 * agora seria decidir por baixo do pano.
 */

interface MemberRow {
  organization_id: string;
  user_id: string;
  role: string;
  created_at: string;
  profiles: { full_name: string | null } | null;
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--sb-text-soft)",
  whiteSpace: "nowrap",
};

const td: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.875rem",
  verticalAlign: "top",
};

function eventoLabel(row: {
  event_type: string;
  previous_role: string | null;
  new_role: string | null;
}): string {
  switch (row.event_type) {
    case "MEMBER_ADDED":
      return `entrou como ${row.new_role ?? "?"}`;
    case "MEMBER_ROLE_CHANGED":
      return `${row.previous_role ?? "?"} → ${row.new_role ?? "?"}`;
    case "MEMBER_REMOVED":
      return `saiu (era ${row.previous_role ?? "?"})`;
    case "ACCOUNT_ACCESS_GRANTED":
      return "ganhou acesso à conta";
    case "ACCOUNT_ACCESS_REVOKED":
      return "perdeu acesso à conta";
    default:
      // Função total: tipo novo do banco degrada para o valor cru.
      return row.event_type;
  }
}

export default async function UsuariosPage(): Promise<ReactNode> {
  const supabase = await createClient();

  const membership = await supabase
    .from("organization_members")
    .select("organization_id, role")
    .maybeSingle();

  const organizationId = membership.data?.organization_id ?? null;
  const myRole = membership.data?.role ?? null;

  if (organizationId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Usuários</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const isAdmin = myRole === "ADMIN";

  const [membersResult, accountsResult, permissionsResult, eventsResult] = await Promise.all([
    supabase
      .from("organization_members")
      .select("organization_id, user_id, role, created_at, profiles(full_name)")
      .order("role"),
    supabase.from("ml_accounts").select("id, label").eq("organization_id", organizationId).order("label"),
    supabase.from("user_account_permissions").select("user_id, ml_account_id"),
    // A policy só devolve linhas para ADMIN — para os demais isto volta
    // vazio, e a seção nem aparece.
    supabase
      .from("organization_access_events")
      .select("id, event_type, target_user_id, ml_account_id, previous_role, new_role, actor_user_id, occurred_at")
      .order("occurred_at", { ascending: false })
      .limit(50),
  ]);

  const members = (membersResult.data ?? []) as unknown as MemberRow[];
  const accounts = accountsResult.data ?? [];
  const permissions = permissionsResult.data ?? [];
  const events = eventsResult.data ?? [];

  const nomePorUsuario = new Map(members.map((m) => [m.user_id, m.profiles?.full_name ?? m.user_id]));
  const contaPorId = new Map(accounts.map((a) => [a.id, a.label]));

  const erro = membersResult.error ?? accountsResult.error ?? permissionsResult.error;

  return (
    <Shell>
      <h1 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.375rem" }}>Usuários</h1>

      <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Membros da organização, o papel de cada um e a quais contas do Mercado Livre têm acesso.{" "}
        {isAdmin
          ? "Como ADMIN, você pode alterar papel e acesso — e o banco impede que a organização fique sem nenhum ADMIN."
          : "Só um ADMIN altera papéis e acessos; esta tela é somente leitura para você."}
      </p>

      {erro !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar os membros: {erro.message}
        </p>
      )}

      <div style={{ overflowX: "auto", marginBottom: "var(--sb-space-4)" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "42rem" }}>
          <thead>
            <tr>
              <th style={th}>Pessoa</th>
              <th style={th}>Papel</th>
              <th style={th}>Contas com acesso</th>
              <th style={th}>Desde</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const granted = permissions
                .filter((p) => p.user_id === member.user_id)
                .map((p) => p.ml_account_id);

              return (
                <tr key={member.user_id}>
                  <td style={td}>
                    {member.profiles?.full_name ?? (
                      <span style={{ color: "var(--sb-text-soft)" }}>sem nome no perfil</span>
                    )}
                  </td>
                  <td style={td}>
                    {isAdmin ? (
                      <RoleSelect
                        organizationId={member.organization_id}
                        userId={member.user_id}
                        role={member.role}
                      />
                    ) : (
                      member.role
                    )}
                  </td>
                  <td style={td}>
                    {isAdmin ? (
                      <AccountAccessControls
                        userId={member.user_id}
                        role={member.role}
                        accounts={accounts}
                        granted={granted}
                      />
                    ) : member.role === "ADMIN" ? (
                      "todas as contas (por ser ADMIN)"
                    ) : granted.length === 0 ? (
                      "nenhuma"
                    ) : (
                      granted.map((id) => contaPorId.get(id) ?? id).join(", ")
                    )}
                  </td>
                  <td style={td}>{formatDateTime(member.created_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {isAdmin && (
        <>
          <h2 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.0625rem" }}>Histórico de acesso</h2>

          <p style={{ margin: "0 0 var(--sb-space-2)", fontSize: "0.75rem", color: "var(--sb-muted-ink)" }}>
            Gravado pelo próprio banco, append-only: nem esta tela nem a API conseguem editar ou apagar uma
            linha. O registro começa em 01/09/2026 — mudanças anteriores não existem aqui, e evento sintético
            seria dado inventado.
          </p>

          {events.length === 0 && (
            <p style={{ color: "var(--sb-text-soft)", fontSize: "0.8125rem" }}>
              Nenhuma mudança de acesso registrada ainda.
            </p>
          )}

          {events.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "42rem" }}>
                <thead>
                  <tr>
                    <th style={th}>Quando</th>
                    <th style={th}>Quem mudou</th>
                    <th style={th}>Sobre quem</th>
                    <th style={th}>O quê</th>
                    <th style={th}>Conta</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={event.id}>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{formatDateTime(event.occurred_at)}</td>
                      <td style={td}>
                        {event.actor_user_id === null ? (
                          // Sem humano identificado: seed, importação ou
                          // migration. Declarar é melhor que inventar.
                          <span style={{ color: "var(--sb-text-soft)" }}>sistema</span>
                        ) : (
                          (nomePorUsuario.get(event.actor_user_id) ?? event.actor_user_id)
                        )}
                      </td>
                      <td style={td}>{nomePorUsuario.get(event.target_user_id) ?? event.target_user_id}</td>
                      <td style={td}>{eventoLabel(event)}</td>
                      <td style={{ ...td, color: "var(--sb-text-soft)" }}>
                        {event.ml_account_id === null ? "—" : (contaPorId.get(event.ml_account_id) ?? event.ml_account_id)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Shell>
  );
}
