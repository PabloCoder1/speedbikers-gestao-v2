import type { ReactNode } from "react";

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
  resolveMemberFilters,
  summarizeMemberWindow,
  type MemberStatus,
} from "../../lib/member-filters";
import { tomDePapel } from "../../lib/role-tone";
import { createClient } from "../../lib/supabase/server";
import { currentMembership } from "../../lib/membership";
import { DetalheUsuario } from "./detalhe-usuario";
import { ConvidarUsuario } from "./convidar";

export const metadata = { title: "Usuários — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/**
 * Administração de Usuários e Permissões (D-175, trilha 8A; refeita contra o
 * frame em D-297).
 *
 * A autorização vive inteira no banco, e isso é de propósito — o item da
 * trilha nomeia "segurança apenas visual" como risco:
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
 * ## A TABELA VOLTOU A SER TABELA (D-297)
 *
 * O usuário comparou esta tela com o frame e disse que a nossa estava "muito
 * inferior". Estava, e o motivo era mensurável: **cada linha carregava um
 * `<select>` de papel e uma caixa por conta** — com quatro contas, são cinco
 * controles por pessoa, e a tabela virou um formulário empilhado. O frame põe
 * SELO em Papel, TEXTO em contas, e abre a pessoa numa gaveta.
 *
 * Os controles não sumiram: eles moram na gaveta, que é onde se olha uma pessoa
 * por vez. Quem pode editar continua podendo; quem não pode, continua não
 * podendo — nada de autorização mudou nesta fatia, só o lugar do controle.
 *
 * As cinco colunas são as do frame, nesta ordem: Usuário / E-mail, Papel,
 * Contas ML permitidas, Status, Último acesso (à direita). **"Desde" saiu da
 * tabela e virou "Membro desde" na gaveta**: ele entrou em D-271 como
 * substituto de "Último acesso", que não tinha fonte; com a fonte aberta em
 * D-296, manter os dois carimbos lado a lado era uma coluna a mais que o frame
 * não tem para responder uma pergunta que a gaveta já responde.
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

export default async function UsuariosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const filters = resolveMemberFilters(await searchParams);
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

  const [membersResult, accountsResult, permissionsResult, eventsResult, detalheResult] = await Promise.all([
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
    /*
      OS TRÊS CAMPOS QUE VIVEM EM `auth.users` (D-296): e-mail, último acesso e
      se o convite já foi aceito. D-271 recusou as três colunas do frame por
      falta de fonte — e a fonte não era o esquema, era a JANELA: `auth.users`
      não é alcançável pela Data API, de propósito.

      `get_organization_members` é essa janela, `security definer` com
      autorização ADMIN DAQUELA organização refeita dentro. Para quem não é
      ADMIN ela devolve zero linhas, e as colunas somem — em vez de aparecerem
      vazias, que seria pior: a tela prometeria um dado que aquele usuário não
      tem como ver.
    */
    isAdmin
      ? supabase.rpc("get_organization_members", { p_organization_id: organizationId })
      : Promise.resolve({ data: null, error: null }),
  ]);

  const members = (membersResult.data ?? []) as unknown as MemberRow[];
  const accounts = accountsResult.data ?? [];
  const permissions = permissionsResult.data ?? [];
  const events = eventsResult.data ?? [];

  const detalhePorUsuario = new Map(
    (detalheResult.data ?? []).map((linha) => [
      linha.user_id,
      { email: linha.email, ultimoAcesso: linha.last_sign_in_at, aceitou: linha.invite_accepted },
    ]),
  );

  /** Convidados que ainda não entraram — o cartão que o frame desenha. */
  const pendentes = (detalheResult.data ?? []).filter((linha) => !linha.invite_accepted).length;

  /*
    O nome que o histórico usa. Convidado que ainda não entrou NÃO TEM perfil —
    `profiles` nasce no primeiro acesso —, e antes de D-296 isso não aparecia
    porque não havia como criar gente pela tela. Agora há: sem o e-mail no
    meio, a linha do histórico mostraria um UUID cru para quem acabou de ser
    convidado, que é o defeito de D-273 em outra tela ("done" na frente de
    quem opera).
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
    organização, então `members.length` É o total, não o tamanho de uma página.
  */
  const PAPEIS = ["ADMIN", "GESTOR", "ANALISTA", "OPERADOR", "VISUALIZADOR"] as const;

  /*
    Quantos ADMIN existem. É o que decide se a gaveta mostra a "Proteção ativa"
    do frame — e o número é o MESMO que o trigger `guard_last_admin` consulta
    para recusar a escrita. A tela não protege nada; ela conta a mesma coisa
    que o banco conta, e diz.
  */
  const admins = members.filter((m) => m.role === "ADMIN").length;

  /*
    AS LINHAS, com tudo já resolvido pelo servidor: nome, e-mail, estado,
    alcance e histórico. A gaveta recebe os mesmos valores que a célula mostra,
    de uma composição só — as duas não podem discordar sobre alcance.
  */
  const linhas = members.map((member) => {
    const detalhe = detalhePorUsuario.get(member.user_id);
    const granted = permissions.filter((p) => p.user_id === member.user_id).map((p) => p.ml_account_id);
    const todasPorAdmin = member.role === "ADMIN";

    /*
      Sem a janela (quem não é ADMIN), `detalhe` é `undefined` e o estado cai em
      "ativo" — mas a coluna nem é renderizada para ele, então o valor não
      aparece em tela. Ele existe para o filtro ter um tipo total.
    */
    const status: MemberStatus = detalhe === undefined || detalhe.aceitou ? "ativo" : "pendente";

    return {
      member,
      granted,
      todasPorAdmin,
      contas: granted.map((id) => contaPorId.get(id) ?? id),
      nome: member.profiles?.full_name ?? null,
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
      formula: "Pessoas com vínculo ativo nesta organização, em qualquer papel.",
      value: formatCount(members.length),
      previous: null,
      tom: "neutro",
    },
    /*
      "CONVITES PENDENTES" DO FRAME, agora com fonte (D-296). D-271 o recusou
      porque não havia convite nenhum: um cartão sempre em zero prometeria um
      fluxo que a tela não tinha. Agora ela tem — e o zero, quando aparecer,
      será um zero medido.

      Só para ADMIN: o número vem da RPC, e ela não responde a mais ninguém.
      O frame pinta este cartão de atenção (borda e número em âmbar) quando há
      convite aberto, e `destaque` é isso (D-297) — sem convite nenhum, ele
      volta a ser uma célula como as outras, porque nada pede atenção.
    */
    ...(isAdmin
      ? [
          {
            label: "Convites pendentes",
            formula:
              "Pessoas com vínculo criado que ainda não entraram nenhuma vez (`auth.users.last_sign_in_at` nulo).",
            value: formatCount(pendentes),
            previous: null,
            tom: pendentes > 0 ? ("atencao" as const) : ("neutro" as const),
            ...(pendentes > 0 ? { destaque: "atencao" as const } : {}),
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
              ? "Como ADMIN, você pode alterar papel e acesso na gaveta de cada pessoa — e o banco impede que a organização fique sem nenhum ADMIN."
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

        A quinta célula dele, "Convites Pendentes", ENTROU em D-296, quando o
        convite passou a existir.
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
          A janela só entra no subtítulo quando HÁ linhas. Sem isso ela aparecia
          duas vezes na tela vazia — uma no subtítulo, outra no lugar da tabela
          —, e a mesma frase repetida a 3cm de distância lê-se como defeito.
        */
        subtitle={
          visiveis.length === 0
            ? "O papel decide o que a pessoa PODE fazer; as contas decidem sobre o que ela faz."
            : `O papel decide o que a pessoa PODE fazer; as contas decidem sobre o que ela faz. ${janela}`
        }
        aside={
          <>
            {/*
              A busca do frame ("Buscar usuário ou e-mail…"), como GET nativo: o
              recorte fica na URL, nunca em estado React. O `hidden` do estado é
              obrigatório porque um form GET só envia os campos que tem — sem
              ele, buscar limparia o filtro de Status (a regra de `/compras`).
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

            {/*
              O "Status ⌄" do frame — e só para ADMIN, porque o estado vem da
              janela de D-296. Oferecer o menu a quem não recebe o dado seria um
              filtro que não recorta nada.
            */}
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
              {/*
                As colunas do frame, na ordem dele. "Usuário / E-mail" traz o
                e-mail sob o nome desde D-296, pela janela de `auth.users`.
              */}
              <th>Usuário / E-mail</th>
              <th>Papel</th>
              <th>Contas ML permitidas</th>
              {/*
                STATUS e ÚLTIMO ACESSO entram para ADMIN (D-296). Para quem não
                é ADMIN elas somem: coluna vazia prometeria um dado que aquele
                usuário não tem como ver.
              */}
              {isAdmin && <th>Status</th>}
              {isAdmin && <th className="sb-num">Último acesso</th>}
            </tr>
          </thead>
          <tbody>
            {visiveis.map((linha) => (
              <tr key={linha.member.user_id}>
                <td>
                  {/*
                    O NOME É O GATILHO da gaveta, como a linha clicável do
                    frame — e a coluna "Inspecionar" que existia aqui saiu com
                    ele. O nome acessível desta célula continua sendo nome +
                    e-mail, que é o que `usuarios.spec.ts` afirma (D-234).
                  */}
                  <DetalheUsuario
                    accounts={accounts}
                    contas={linha.contas}
                    desde={formatDateTime(linha.member.created_at)}
                    editavel={isAdmin}
                    ehUltimoAdmin={linha.member.role === "ADMIN" && admins === 1}
                    email={linha.email}
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

                  {/*
                    O e-mail embaixo do nome, como o frame desenha. Só para
                    ADMIN, e sem inventar: quem não tem e-mail no Auth aparece
                    sem a linha, não com um traço.
                  */}
                  {linha.email !== null && (
                    <div style={{ fontSize: "0.625rem", color: "var(--sb-text-soft)" }}>{linha.email}</div>
                  )}
                </td>
                <td>
                  {/*
                    SELO, não `<select>` (D-297). O menu de papel mora na
                    gaveta: cinco controles por linha faziam a tabela se ler
                    como formulário, que é o que o usuário comparou com o frame.
                  */}
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
                    <span className="sb-status" style={linha.status === "ativo" ? TOM.ok : TOM.neutro}>
                      {memberStatusLabel(linha.status)}
                    </span>
                  </td>
                )}
                {isAdmin && (
                  /*
                    À direita, como no frame. Nunca entrou é "—", não uma data
                    inventada: o convite pode estar aberto há semanas, e o traço
                    diz isso.
                  */
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
