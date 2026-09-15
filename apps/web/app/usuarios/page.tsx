import type { ReactNode } from "react";

import { Avatar } from "../../components/avatar";
import { FilterMenu } from "../../components/filter-menu";
import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { PageTitle } from "../../components/page-title";
import { TOM } from "../../components/tone";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { formatCount, formatDateTime } from "../../lib/format";
import { roleLabel } from "../../lib/labels";
import {
  MEMBER_STATUSES,
  buildMemberHref,
  matchesMemberFilters,
  memberStatusLabel,
  memberStatusTone,
  resolveMemberFilters,
  summarizeMemberWindow,
  type MemberStatus,
} from "../../lib/member-filters";
import { tomDePapel } from "../../lib/role-tone";
import { createClient } from "../../lib/supabase/server";
import { currentMembership } from "../../lib/request-membership";
import { DetalheUsuario } from "./detalhe-usuario";
import { ConvidarUsuario } from "./convidar";

export const metadata = { title: "Usuários — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/**
 * Administração de Usuários e Permissões (D-175, trilha 8A; refeita contra o
 * frame em D-297; nome, foto, suspender e remover em D-354).
 *
 * A autorização vive inteira no banco, e isso é de propósito — o item da
 * trilha nomeia "segurança apenas visual" como risco:
 *
 * - quem pode escrever: as policies `*_admin_writes` e, para nome e foto,
 *   `profiles_update_self_or_org_admin` (D-354);
 * - o que não pode acontecer nunca: o trigger `guard_last_admin`, que impede
 *   a organização de ficar sem ADMIN por qualquer caminho de escrita;
 * - o que aconteceu: `organization_access_events`, append-only.
 *
 * Esconder os controles de quem não é ADMIN é conveniência. Se alguém chamar
 * a Server Action direto, a policy recusa igual.
 *
 * ## A TABELA CONTINUA SENDO TABELA (D-297)
 *
 * Cinco colunas, as do frame: Usuário / E-mail, Papel, Contas ML permitidas,
 * Status, Último acesso. Nenhum controle dentro de célula — papel, alcance,
 * nome, foto, suspender e remover moram na GAVETA, que é onde se olha uma
 * pessoa por vez. D-354 acrescentou à linha só o que é LEITURA: o avatar e o
 * estado "Suspenso".
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
      `get_organization_members`, `security definer` com autorização ADMIN
      DAQUELA organização refeita dentro; para os demais, zero linhas.
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
    Convidados que ainda não entraram — o cartão que o frame desenha. Suspenso
    não conta como pendente mesmo sem nunca ter entrado: o que falta para ele
    não é aceitar o convite, é ser reativado.
  */
  const pendentes = (detalheResult.data ?? []).filter((linha) => !linha.invite_accepted && !linha.suspended).length;
  const suspensos = (detalheResult.data ?? []).filter((linha) => linha.suspended).length;

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
    Contados sobre a lista inteira — ela não pagina, e a RLS já a restringe à
    organização, então `members.length` É o total.
  */
  const PAPEIS = ["ADMIN", "GESTOR", "ANALISTA", "OPERADOR", "VISUALIZADOR"] as const;

  /*
    Quantos ADMIN existem — o MESMO número que o trigger `guard_last_admin`
    consulta. A tela não protege nada; ela conta o que o banco conta, e diz.
  */
  const admins = members.filter((m) => m.role === "ADMIN").length;

  const linhas = members.map((member) => {
    const detalhe = detalhePorUsuario.get(member.user_id);
    const granted = permissions.filter((p) => p.user_id === member.user_id).map((p) => p.ml_account_id);
    const todasPorAdmin = member.role === "ADMIN";

    /*
      Sem a janela (quem não é ADMIN), `detalhe` é `undefined` e o estado cai em
      "ativo" — mas a coluna nem é renderizada para ele. Suspenso vence os
      outros dois: é o estado que decide se a pessoa ENTRA.
    */
    const status: MemberStatus =
      detalhe === undefined ? "ativo" : detalhe.suspenso ? "suspenso" : detalhe.aceitou ? "ativo" : "pendente";

    return {
      member,
      granted,
      todasPorAdmin,
      contas: granted.map((id) => contaPorId.get(id) ?? id),
      nome: member.profiles?.full_name ?? null,
      foto: member.profiles?.avatar_path ?? null,
      email: detalhe?.email ?? null,
      ultimoAcesso: detalhe?.ultimoAcesso ?? null,
      status,
    };
  });

  const visiveis = linhas.filter((linha) =>
    matchesMemberFilters({ nome: linha.nome, email: linha.email, status: linha.status }, filters),
  );

  const janela = summarizeMemberWindow(linhas.length, visiveis.length, filters);

  const celulas: KpiCellData[] = [
    {
      label: "Membros",
      formula: "Pessoas com vínculo nesta organização, em qualquer papel e estado.",
      value: formatCount(members.length),
      previous: null,
      tom: "neutro",
    },
    /*
      "CONVITES PENDENTES" DO FRAME (D-296), só para ADMIN — o número vem da
      janela, que não responde a mais ninguém. Com convite aberto o cartão pede
      atenção; sem nenhum, volta ao neutro.
    */
    ...(isAdmin
      ? [
          {
            label: "Convites pendentes",
            formula:
              "Pessoas com vínculo criado que ainda não entraram nenhuma vez (`auth.users.last_sign_in_at` nulo) e não estão suspensas.",
            value: formatCount(pendentes),
            previous: null,
            tom: pendentes > 0 ? ("atencao" as const) : ("neutro" as const),
            ...(pendentes > 0 ? { destaque: "atencao" as const } : {}),
          } satisfies KpiCellData,
        ]
      : []),
    /*
      SUSPENSOS (D-354) só aparece quando HÁ alguém suspenso. Não é zero
      escondido: a faixa já tem sete células, e uma oitava sempre em zero
      apertaria as outras para responder uma pergunta que a coluna Status e o
      filtro já respondem. Quando existe, ela pede atenção — há gente que não
      consegue entrar.
    */
    ...(isAdmin && suspensos > 0
      ? [
          {
            label: "Suspensos",
            formula: "Pessoas com acesso suspenso no Auth (`auth.users.banned_until` no futuro).",
            value: formatCount(suspensos),
            previous: null,
            tom: "atencao" as const,
            destaque: "atencao" as const,
          } satisfies KpiCellData,
        ]
      : []),
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
        aside={isAdmin ? <ConvidarUsuario accounts={accounts} /> : undefined}
        eyebrow="ADMINISTRAÇÃO / USUÁRIOS E ACESSOS"
        title="Usuários"
        subtitle={
          <>
            Pessoas, papéis e alcance de cada permissão.{" "}
            {isAdmin
              ? "Como ADMIN, você edita nome, foto, papel e acesso na gaveta de cada pessoa — e pode suspender ou remover. O banco impede que a organização fique sem nenhum ADMIN."
              : "Só um ADMIN altera papéis e acessos; esta tela é somente leitura para você."}
          </>
        }
      />

      {/*
        As células: Membros, Convites pendentes (ADMIN), Suspensos (ADMIN, só
        quando há) e os CINCO papéis do `check` — o frame dá cartão a três, e
        com três os cartões deixariam de fechar com o total (D-265).
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
          /*
            A janela só entra no subtítulo quando HÁ linhas: na tela vazia ela
            já aparece no lugar da tabela, e a mesma frase repetida lê-se como
            defeito.
          */
          subtitle={
            visiveis.length === 0
              ? "O papel decide o que a pessoa PODE fazer; as contas decidem sobre o que ela faz."
              : `O papel decide o que a pessoa PODE fazer; as contas decidem sobre o que ela faz. ${janela}`
          }
          aside={
            <>
              {/*
                A busca do frame, como GET nativo: o recorte fica na URL. O
                `hidden` do estado é obrigatório — um form GET só envia os
                campos que tem, e buscar limparia o filtro de Status.
              */}
              <form method="get" style={{ display: "flex", gap: "0.375rem", alignItems: "center" }}>
                {filters.status !== null && <input type="hidden" name="estado" value={filters.status} />}
                <input
                  className="sb-input"
                  type="search"
                  name="busca"
                  defaultValue={filters.search ?? ""}
                  placeholder={isAdmin ? "Buscar usuário ou e-mail…" : "Buscar usuário…"}
                  aria-label={isAdmin ? "Buscar por nome ou e-mail" : "Buscar por nome"}
                  style={{ minWidth: "12rem" }}
                />
              </form>

              {/* O "Status ⌄" do frame — só para ADMIN, porque o estado vem da janela. */}
              {isAdmin && (
                <FilterMenu
                  rotulo={filters.status === null ? "Status" : memberStatusLabel(filters.status)}
                  opcoes={[
                    {
                      href: buildMemberHref(filters, { status: null }),
                      label: "Todos os status",
                      ativo: filters.status === null,
                    },
                    ...MEMBER_STATUSES.map((estado) => ({
                      href: buildMemberHref(filters, { status: estado }),
                      label: memberStatusLabel(estado),
                      ativo: filters.status === estado,
                    })),
                  ]}
                />
              )}
            </>
          }
        >
          {visiveis.length === 0 ? (
            <p className="sb-empty">{janela}</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="sb-table">
                <thead>
                  <tr>
                    <th>Usuário / E-mail</th>
                    <th>Papel</th>
                    <th>Contas ML permitidas</th>
                    {/* Só para ADMIN: coluna vazia prometeria um dado que o usuário não vê. */}
                    {isAdmin && <th>Status</th>}
                    {isAdmin && <th className="sb-num">Último acesso</th>}
                  </tr>
                </thead>
                <tbody>
                  {visiveis.map((linha) => (
                    <tr
                      key={linha.member.user_id}
                      className={linha.status === "suspenso" ? "sb-linha-suspensa" : undefined}
                    >
                      <td>
                        <div className="sb-usuario-celula">
                          {/*
                            O AVATAR (D-354): foto quando há, iniciais quando
                            não. `aria-hidden` — o nome acessível da célula
                            continua sendo nome + e-mail, que é o que
                            `usuarios.spec.ts` afirma desde D-234.
                          */}
                          <Avatar nome={linha.nome ?? linha.email ?? "?"} fotoPath={linha.foto} tamanho="sm" />
                          <div className="sb-usuario-celula-texto">
                            {/* O NOME É O GATILHO da gaveta, como a linha clicável do frame. */}
                            <DetalheUsuario
                              accounts={accounts}
                              contas={linha.contas}
                              desde={formatDateTime(linha.member.created_at)}
                              editavel={isAdmin}
                              ehUltimoAdmin={linha.member.role === "ADMIN" && admins === 1}
                              ehVoceMesmo={linha.member.user_id === meuId}
                              email={linha.email}
                              fotoPath={linha.foto}
                              granted={linha.granted}
                              historicoVisivel={isAdmin}
                              nome={linha.nome}
                              organizationId={linha.member.organization_id}
                              role={linha.member.role}
                              roleLabel={roleLabel(linha.member.role)}
                              status={linha.status}
                              todasPorAdmin={linha.todasPorAdmin}
                              ultimoAcesso={formatDateTime(linha.ultimoAcesso)}
                              userId={linha.member.user_id}
                              historico={events
                                .filter((evento) => evento.target_user_id === linha.member.user_id)
                                .map((evento) => ({
                                  id: evento.id,
                                  quando: formatDateTime(evento.occurred_at),
                                  oQue: eventoLabel(evento),
                                  quemMudou:
                                    evento.actor_user_id === null
                                      ? "sistema"
                                      : (nomePorUsuario.get(evento.actor_user_id) ?? evento.actor_user_id),
                                  conta:
                                    evento.ml_account_id === null
                                      ? null
                                      : (contaPorId.get(evento.ml_account_id) ?? evento.ml_account_id),
                                }))}
                            />

                            {linha.email !== null && <div className="sb-usuario-celula-email">{linha.email}</div>}
                          </div>
                        </div>
                      </td>
                      <td>
                        {/* SELO, não `<select>` (D-297). O menu de papel mora na gaveta. */}
                        <span className="sb-status" style={TOM[tomDePapel(linha.member.role)]}>
                          {roleLabel(linha.member.role)}
                        </span>
                      </td>
                      <td style={{ color: "var(--sb-text-soft)" }}>
                        {linha.todasPorAdmin
                          ? "Todas as contas"
                          : linha.contas.length === 0
                            ? "Nenhuma conta associada"
                            : linha.contas.join(" · ")}
                      </td>
                      {isAdmin && (
                        <td>
                          <span className="sb-status" style={TOM[memberStatusTone(linha.status)]}>
                            {memberStatusLabel(linha.status)}
                          </span>
                        </td>
                      )}
                      {isAdmin && (
                        /* Nunca entrou é "—", não uma data inventada. */
                        <td className="sb-num" style={{ whiteSpace: "nowrap" }}>
                          {formatDateTime(linha.ultimoAcesso)}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      {isAdmin && (
        <div style={{ marginTop: "var(--sb-space-3)" }}>
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
                            // Sem humano identificado: seed, importação ou migration.
                            <span style={{ color: "var(--sb-text-soft)" }}>sistema</span>
                          ) : (
                            (nomePorUsuario.get(event.actor_user_id) ?? event.actor_user_id)
                          )}
                        </td>
                        <td>{nomePorUsuario.get(event.target_user_id) ?? event.target_user_id}</td>
                        <td>{eventoLabel(event)}</td>
                        <td style={{ color: "var(--sb-text-soft)" }}>
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
