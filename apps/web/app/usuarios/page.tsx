import type { ReactNode } from "react";

import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { formatCount, formatDateTime } from "../../lib/format";
import { roleLabel } from "../../lib/labels";
import { createClient } from "../../lib/supabase/server";
import { currentMembership } from "../../lib/membership";
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

  /*
    DEFEITO VIVO, achado abrindo a tela nesta fatia (D-271).

    Isto era `.from("organization_members").select(...).maybeSingle()` — **sem
    filtrar por usuário**. Sob RLS aquela leitura devolve TODOS os membros da
    organização; com dois, o PostgREST responde `PGRST116`, `data` vira nulo e a
    tela dizia "Sua conta não está associada a nenhuma organização" **para o
    próprio ADMIN**.

    É exatamente a classe que D-234 corrigiu em ~25 telas — e que passou por
    esta. A ironia importa para entender por que ninguém viu: `/usuarios` é
    justamente onde se cadastra o segundo usuário, ou seja, a tela que o ato
    quebra é a tela que o ato usa.

    `currentMembership` lê pela RPC `get_current_membership`, que filtra por
    `auth.uid()`, e é o que todas as outras telas já usavam.
  */
  const membership = await currentMembership(supabase);

  const organizationId = membership.organizationId;
  const myRole = membership.role;

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

  /*
    Os CINCO papéis do `check` de `organization_members`, na ordem de alcance.
    Contados sobre a lista inteira — ela não pagina, e a RLS já a restringe à
    organização, então `members.length` É o total, não o tamanho de uma página.
  */
  const PAPEIS = ["ADMIN", "GESTOR", "ANALISTA", "OPERADOR", "VISUALIZADOR"] as const;

  const celulas: KpiCellData[] = [
    {
      label: "Membros",
      formula: "Pessoas com vínculo ativo nesta organização, em qualquer papel.",
      value: formatCount(members.length),
      previous: null,
      tom: "neutro",
    },
    ...PAPEIS.map(
      (papel): KpiCellData => ({
        label: roleLabel(papel),
        formula: `Membros com papel ${papel}.`,
        value: formatCount(members.filter((m) => m.role === papel).length),
        previous: null,
        // ADMIN é o papel que muda permissão dos outros; os demais são
        // neutros. Nenhum é "bom" ou "ruim" — só um tem alcance diferente.
        tom: papel === "ADMIN" ? "atencao" : "neutro",
      }),
    ),
  ];

  return (
    <Shell>
      <PageTitle
        eyebrow="ADMINISTRAÇÃO / USUÁRIOS E ACESSOS"
        title="Usuários"
        subtitle={
          <>
            Pessoas, papéis e alcance de cada permissão.{" "}
            {isAdmin
              ? "Como ADMIN, você pode alterar papel e acesso — e o banco impede que a organização fique sem nenhum ADMIN."
              : "Só um ADMIN altera papéis e acessos; esta tela é somente leitura para você."}
          </>
        }
      />

      {/*
        SEIS células, e o frame desenha cinco — mas não são as mesmas cinco.

        Ele dá cartão a Administradores, Gestores e Operadores, e o `check` de
        `organization_members` conhece CINCO papéis: ADMIN, GESTOR, **ANALISTA**,
        OPERADOR e **VISUALIZADOR**. Mostrar três faria os cartões não fecharem
        com o total no dia em que alguém for cadastrado como analista — a mesma
        aritmética que denunciou o frame da Central Full (D-265).

        E a quinta célula dele, "Convites Pendentes", NÃO ENTRA: não existe
        tabela de convite no esquema. Um cartão sempre em zero prometeria um
        fluxo que a tela não tem.
      */}
      <KpiStrip cells={celulas} />

      {erro !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar os membros: {erro.message}
        </p>
      )}

      <div style={{ marginTop: "var(--sb-space-3)" }}>
      <Panel
        title="Gerenciar acessos"
        subtitle="O papel decide o que a pessoa PODE fazer; as contas decidem sobre o que ela faz."
      >
      <div style={{ overflowX: "auto" }}>
        <table className="sb-table">
          <thead>
            <tr>
              {/*
                O frame mostra "Usuário / E-mail". O e-mail NÃO ENTRA: `profiles`
                tem `id`, `full_name`, `created_at` e `updated_at` — o endereço
                vive em `auth.users`, que o PostgREST não expõe. Buscá-lo exigiria
                uma função `security definer` só para exibir contato, e isso é
                feature, não composição.
              */}
              <th>Pessoa</th>
              <th>Papel</th>
              <th>Contas com acesso</th>
              {/*
                Onde o frame põe "Status" e "Último acesso" — as duas sem fonte.
                Status seria coluna de um valor só: não há tabela de convite, logo
                todo membro está ativo por construção. E o último acesso é
                `auth.users.last_sign_in_at`, fora do alcance do PostgREST;
                nenhuma coluna nem função em `public` o expõe (medido).

                "Desde" fica: é `created_at` do vínculo, e responde a pergunta
                vizinha — há quanto tempo esta pessoa tem este acesso.
              */}
              <th>Desde</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const granted = permissions
                .filter((p) => p.user_id === member.user_id)
                .map((p) => p.ml_account_id);

              return (
                <tr key={member.user_id}>
                  <td>
                    {member.profiles?.full_name ?? (
                      <span style={{ color: "var(--sb-text-soft)" }}>sem nome no perfil</span>
                    )}
                  </td>
                  <td>
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
                  <td>
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
                  <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(member.created_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      </Panel>
      </div>

      {isAdmin && (
        <div style={{ marginTop: "var(--sb-space-3)" }}>
          {/*
            A JANELA VAI NO SUBTÍTULO, e não no `aside` do painel.

            `.sb-panel-head` é flex com `wrap`: subtítulo longo empurra o
            `aside` para a linha de baixo, à esquerda, onde "últimas 50" vira
            um rótulo solto sem dono. O que precisa ser dito é o TAMANHO DA
            JANELA (D-131) — dizer isso na frase custa nada e não depende do
            comprimento do texto vizinho.
          */}
          <Panel
            title="Histórico de acesso"
            subtitle="Gravado pelo próprio banco, append-only: nem esta tela nem a API conseguem editar ou apagar uma linha. O registro começa em 01/09/2026 — mudanças anteriores não existem aqui, e evento sintético seria dado inventado. Mostra as 50 mudanças mais recentes."
          >
          {events.length === 0 && (
            <p style={{ color: "var(--sb-text-soft)", fontSize: "0.8125rem" }}>
              Nenhuma mudança de acesso registrada ainda.
            </p>
          )}

          {events.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table className="sb-table">
                <thead>
                  <tr>
                    <th>Quando</th>
                    <th>Quem mudou</th>
                    <th>Sobre quem</th>
                    <th>O quê</th>
                    <th>Conta</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={event.id}>
                      <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(event.occurred_at)}</td>
                      <td>
                        {event.actor_user_id === null ? (
                          // Sem humano identificado: seed, importação ou
                          // migration. Declarar é melhor que inventar.
                          <span style={{ color: "var(--sb-text-soft)" }}>sistema</span>
                        ) : (
                          (nomePorUsuario.get(event.actor_user_id) ?? event.actor_user_id)
                        )}
                      </td>
                      <td>{nomePorUsuario.get(event.target_user_id) ?? event.target_user_id}</td>
                      <td>{eventoLabel(event)}</td>
                      <td style={{ color: "var(--sb-text-soft)" }}>
                        {event.ml_account_id === null ? "—" : (contaPorId.get(event.ml_account_id) ?? event.ml_account_id)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          </Panel>
        </div>
      )}
    </Shell>
  );
}
