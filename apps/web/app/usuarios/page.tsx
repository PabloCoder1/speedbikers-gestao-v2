import type { ReactNode } from "react";

import { Icone } from "../../components/icons";
import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { formatCount, formatDateTime } from "../../lib/format";
import { roleLabel } from "../../lib/labels";
import {
  matchesMemberFilters,
  resolveMemberFilters,
  summarizeMemberWindow,
  type MemberStatus,
} from "../../lib/member-filters";
import { createClient } from "../../lib/supabase/server";
import { currentMembership } from "../../lib/request-membership";
import { tempoRelativo } from "../../lib/tempo-relativo";
import { ConvidarUsuario } from "./convidar";
import { FiltroDeStatus, TabelaDeUsuarios, type LinhaDeUsuario } from "./tabela-usuarios";

export const metadata = { title: "Usuários — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/**
 * Administração de Usuários e Permissões (D-175, trilha 8A; refeita contra o
 * frame em D-297; nome, foto, suspender e remover em D-354; composição em D-355).
 *
 * A autorização vive inteira no banco, e isso é de propósito — o item da
 * trilha nomeia "segurança apenas visual" como risco:
 *
 * - quem pode escrever: as policies `*_admin_writes` e, para nome e foto,
 *   `profiles_update_self_or_org_admin` (D-354);
 * - o que não pode acontecer nunca: o trigger `guard_last_admin`;
 * - o que aconteceu: `organization_access_events`, append-only.
 *
 * Esconder os controles de quem não é ADMIN é conveniência. Se alguém chamar
 * a Server Action direto, a policy recusa igual.
 *
 * **Esta página LÊ e DECIDE; `tabela-usuarios.tsx` DESENHA.** Cada valor que
 * aparece — estado, alcance, tempo relativo, quem é o último ADMIN — é
 * resolvido aqui, uma vez, e a tabela e a gaveta recebem o mesmo objeto: as
 * duas não podem discordar sobre uma pessoa.
 */

interface MemberRow {
  organization_id: string;
  user_id: string;
  role: string;
  created_at: string;
  profiles: { full_name: string | null; avatar_path: string | null } | null;
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
    case "MEMBER_SUSPENDED":
      return "acesso suspenso";
    case "MEMBER_REACTIVATED":
      return "acesso reativado";
    default:
      // Função total: tipo novo do banco degrada para o valor cru.
      return row.event_type;
  }
}

export default async function UsuariosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const filters = resolveMemberFilters(await searchParams);
  const supabase = await createClient();

  /*
    `currentMembership` lê pela RPC `get_current_membership`, que filtra por
    `auth.uid()` — a leitura sem filtro que dizia "sem organização" para o
    próprio ADMIN com dois membros é o defeito de D-271, e não volta.
  */
  const membership = await currentMembership();

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

  const [membersResult, accountsResult, permissionsResult, eventsResult, detalheResult, sessao] = await Promise.all([
    supabase
      .from("organization_members")
      .select("organization_id, user_id, role, created_at, profiles(full_name, avatar_path)")
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
    /*
      OS CAMPOS QUE VIVEM EM `auth.users` (D-296, D-354): e-mail, último acesso,
      se o convite já foi aceito e se o acesso está suspenso. A janela é
      `get_organization_members`, com autorização ADMIN refeita dentro.
    */
    isAdmin
      ? supabase.rpc("get_organization_members", { p_organization_id: organizationId })
      : Promise.resolve({ data: null, error: null }),
    /*
      QUEM ESTÁ OLHANDO, para a gaveta não oferecer "suspender" e "remover" sobre
      a própria conta. `getSession` lê o cookie, sem ida ao Auth: é só para
      desenhar — quem recusa suspender a si mesmo é a `api`.
    */
    supabase.auth.getSession(),
  ]);

  const members = (membersResult.data ?? []) as unknown as MemberRow[];
  const accounts = accountsResult.data ?? [];
  const permissions = permissionsResult.data ?? [];
  const events = eventsResult.data ?? [];
  const meuId = sessao.data.session?.user.id ?? null;
  const agora = new Date();

  const detalhePorUsuario = new Map(
    (detalheResult.data ?? []).map((linha) => [
      linha.user_id,
      {
        email: linha.email,
        ultimoAcesso: linha.last_sign_in_at,
        aceitou: linha.invite_accepted,
        suspenso: linha.suspended,
      },
    ]),
  );

  /*
    O nome que o histórico usa. Sem nome no perfil, o e-mail; sem e-mail (quem
    não é ADMIN), o id — nunca um UUID quando há coisa melhor (D-273).
  */
  const nomePorUsuario = new Map(
    members.map((m) => [
      m.user_id,
      m.profiles?.full_name ?? detalhePorUsuario.get(m.user_id)?.email ?? m.user_id,
    ]),
  );
  const contaPorId = new Map(accounts.map((a) => [a.id, a.label]));

  const erro = membersResult.error ?? accountsResult.error ?? permissionsResult.error;

  /*
    Os CINCO papéis do `check` de `organization_members`, na ordem de alcance.
    A lista não pagina, e a RLS a restringe à organização: `members.length` É o total.
  */
  const PAPEIS = ["ADMIN", "GESTOR", "ANALISTA", "OPERADOR", "VISUALIZADOR"] as const;

  /* Quantos ADMIN existem — o MESMO número que o trigger `guard_last_admin` consulta. */
  const admins = members.filter((m) => m.role === "ADMIN").length;

  const linhas: LinhaDeUsuario[] = members.map((member) => {
    const detalhe = detalhePorUsuario.get(member.user_id);
    const granted = permissions.filter((p) => p.user_id === member.user_id).map((p) => p.ml_account_id);

    /*
      Sem a janela (quem não é ADMIN), `detalhe` é `undefined` e o estado cai em
      "ativo" — mas a coluna nem é renderizada para ele. Suspenso vence os
      outros dois: é o estado que decide se a pessoa ENTRA.
    */
    const status: MemberStatus =
      detalhe === undefined ? "ativo" : detalhe.suspenso ? "suspenso" : detalhe.aceitou ? "ativo" : "pendente";

    const ultimoAcesso = detalhe?.ultimoAcesso ?? null;

    return {
      userId: member.user_id,
      organizationId: member.organization_id,
      role: member.role,
      roleLabel: roleLabel(member.role),
      nome: member.profiles?.full_name ?? null,
      foto: member.profiles?.avatar_path ?? null,
      email: detalhe?.email ?? null,
      status,
      contas: granted.map((id) => contaPorId.get(id) ?? id),
      granted,
      todasPorAdmin: member.role === "ADMIN",
      desde: formatDateTime(member.created_at),
      ultimoAcesso: formatDateTime(ultimoAcesso),
      ultimoAcessoRelativo: tempoRelativo(ultimoAcesso, agora),
      ehUltimoAdmin: member.role === "ADMIN" && admins === 1,
      ehVoceMesmo: member.user_id === meuId,
      historico: events
        .filter((evento) => evento.target_user_id === member.user_id)
        .map((evento) => ({
          id: evento.id,
          quando: formatDateTime(evento.occurred_at),
          oQue: eventoLabel(evento),
          quemMudou:
            evento.actor_user_id === null
              ? "sistema"
              : (nomePorUsuario.get(evento.actor_user_id) ?? evento.actor_user_id),
          conta: evento.ml_account_id === null ? null : (contaPorId.get(evento.ml_account_id) ?? evento.ml_account_id),
        })),
    };
  });

  const visiveis = linhas.filter((linha) =>
    matchesMemberFilters({ nome: linha.nome, email: linha.email, status: linha.status }, filters),
  );

  const janela = summarizeMemberWindow(linhas.length, visiveis.length, filters);

  /* Contagem por estado sobre a organização inteira — é o que as pílulas dizem. */
  const porStatus: Record<MemberStatus, number> = { ativo: 0, pendente: 0, suspenso: 0 };

  for (const linha of linhas) porStatus[linha.status] += 1;

  const celulas: KpiCellData[] = [
    {
      label: "Membros",
      formula: "Pessoas com vínculo nesta organização, em qualquer papel e estado.",
      value: formatCount(members.length),
      previous: null,
      tom: "neutro",
    },
    /*
      "CONVITES PENDENTES" DO FRAME (D-296), só para ADMIN. Com convite aberto o
      cartão pede atenção; sem nenhum, volta ao neutro.
    */
    ...(isAdmin
      ? [
          {
            label: "Convites pendentes",
            formula:
              "Pessoas com vínculo criado que ainda não entraram nenhuma vez (`auth.users.last_sign_in_at` nulo) e não estão suspensas.",
            value: formatCount(porStatus.pendente),
            previous: null,
            tom: porStatus.pendente > 0 ? ("atencao" as const) : ("neutro" as const),
            ...(porStatus.pendente > 0 ? { destaque: "atencao" as const } : {}),
          } satisfies KpiCellData,
        ]
      : []),
    ...PAPEIS.map(
      (papel): KpiCellData => ({
        label: roleLabel(papel),
        formula: `Membros com papel ${papel}.`,
        value: formatCount(members.filter((m) => m.role === papel).length),
        previous: null,
        // ADMIN é o papel que muda permissão dos outros; os demais são neutros.
        tom: papel === "ADMIN" ? "atencao" : "neutro",
      }),
    ),
  ];

  return (
    <Shell>
      <PageTitle
        aside={isAdmin ? <ConvidarUsuario accounts={accounts} /> : undefined}
        eyebrow="ADMINISTRAÇÃO / USUÁRIOS E ACESSOS"
        title="Usuários"
        subtitle={
          isAdmin
            ? "Pessoas, papéis e alcance de cada permissão. Clique numa pessoa para editar nome, foto, papel e acesso."
            : "Pessoas, papéis e alcance de cada permissão. Só um ADMIN altera papéis e acessos; esta tela é somente leitura para você."
        }
      />

      {/*
        A faixa: Membros, Convites pendentes (ADMIN) e os CINCO papéis do
        `check`. "Suspensos" saiu daqui para a pílula do filtro (D-355): lá ela
        está sempre, com o número, e filtra com um clique.
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
          subtitle={`O papel decide o que a pessoa PODE fazer; as contas decidem sobre o que ela faz. ${janela}`}
          aside={
            /*
              A busca, como GET nativo: o recorte fica na URL. O `hidden` do
              estado é obrigatório — um form GET só envia os campos que tem, e
              buscar limparia o filtro de status.
            */
            <form method="get" className="sb-busca-usuarios">
              {filters.status !== null && <input type="hidden" name="estado" value={filters.status} />}
              <Icone nome="lupa" tamanho={14} />
              <input
                className="sb-input"
                type="search"
                name="busca"
                defaultValue={filters.search ?? ""}
                placeholder={isAdmin ? "Buscar usuário ou e-mail…" : "Buscar usuário…"}
                aria-label={isAdmin ? "Buscar por nome ou e-mail" : "Buscar por nome"}
              />
            </form>
          }
        >
          {/* O estado vem da janela: sem ela (quem não é ADMIN), não há o que filtrar. */}
          {isAdmin && (
            <div className="sb-usuarios-barra">
              <FiltroDeStatus filters={filters} contagens={porStatus} total={linhas.length} />
            </div>
          )}

          {visiveis.length === 0 ? (
            <div className="sb-usuarios-vazio">
              <Icone nome="pessoas" tamanho={28} />
              <p>{janela}</p>
            </div>
          ) : (
            <TabelaDeUsuarios linhas={visiveis} isAdmin={isAdmin} accounts={accounts} />
          )}
        </Panel>
      </div>

      {isAdmin && (
        <div style={{ marginTop: "var(--sb-space-3)" }}>
          <Panel
            title="Histórico de acesso"
            subtitle="Gravado pelo próprio banco, append-only: nem esta tela nem a API conseguem editar ou apagar uma linha. O registro começa em 01/09/2026 — mudanças anteriores não existem aqui, e evento sintético seria dado inventado. Mostra as 50 mudanças mais recentes."
          >
            {events.length === 0 ? (
              <p className="sb-empty">Nenhuma mudança de acesso registrada ainda.</p>
            ) : (
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
                        <td style={{ whiteSpace: "nowrap" }} title={formatDateTime(event.occurred_at)}>
                          {tempoRelativo(event.occurred_at, agora) ?? formatDateTime(event.occurred_at)}
                        </td>
                        <td>
                          {event.actor_user_id === null ? (
                            // Sem humano identificado: seed, importação ou migration.
                            <span className="sb-texto-suave">sistema</span>
                          ) : (
                            (nomePorUsuario.get(event.actor_user_id) ?? event.actor_user_id)
                          )}
                        </td>
                        <td>{nomePorUsuario.get(event.target_user_id) ?? event.target_user_id}</td>
                        <td>{eventoLabel(event)}</td>
                        <td className="sb-texto-suave">
                          {event.ml_account_id === null
                            ? "—"
                            : (contaPorId.get(event.ml_account_id) ?? event.ml_account_id)}
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
