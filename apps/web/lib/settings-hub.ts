/**
 * Hub de Configurações (D-233) — a peça PURA de `/configuracoes`, no padrão de
 * `lib/integrations.ts`: recebe UMA linha de `get_settings_overview` (todas
 * as contagens já feitas no banco, sob a RLS de quem pergunta) e devolve as
 * sete seções que o item do ROADMAP lista —
 * `Organização | Reposição | Notificações | Mercado Livre | IA/Copiloto | Operação | Preferências` —
 * cada uma com o resumo do que existe, QUEM altera e ONDE.
 *
 * A decisão registrada no item era "embutir ou apontar para a tela dona". A
 * resposta é APONTAR, e este módulo é a razão de a resposta ser segura: ele
 * não sabe editar nada. Um dado, um dono (D-224) — a tela dona continua sendo
 * a única com formulário e a única que valida. Zero cópia divergente porque
 * não há cópia: só leitura e link.
 *
 * "Quem altera" é texto copiado das policies (o nome de cada uma está no
 * comentário), e cópia é risco. Por isso o teste de integração
 * `hub de configuracoes: quem altera bate com as policies (D-233)` confere
 * essa frase contra `pg_policy` a cada CI — se alguém mudar uma policy e não
 * esta lista, o teste falha.
 */

export type SettingState = "configurado" | "parcial" | "nao_configurado" | "nao_editavel" | "indisponivel";

export interface SettingsLink {
  label: string;
  href: string;
}

export interface SettingsSection {
  id: "organizacao" | "reposicao" | "notificacoes" | "mercado_livre" | "ia" | "operacao" | "preferencias";
  label: string;
  state: SettingState;
  /** Uma linha: o que existe hoje, com número quando há número. */
  summary: string;
  /** Quem pode alterar — copiado das policies, guardado por teste de integração. */
  editors: string;
  /** A(s) tela(s) dona(s). O Hub não edita; aponta. */
  links: SettingsLink[];
}

/** A linha de `get_settings_overview`, como chega do banco (bigint vira number no PostgREST). */
export interface SettingsOverview {
  organization_name: string | null;
  organization_slug: string | null;
  members_total: number;
  members_admin: number;
  replenishment_default: number;
  replenishment_brand: number;
  replenishment_sku: number;
  notification_prefs_mine: number;
  notification_global_min_severity: string | null;
  notification_global_enabled: boolean | null;
  saved_filters_mine: number;
  reply_templates: number;
  knowledge_entries: number;
  knowledge_validated: number;
  ml_accounts_total: number;
  ml_accounts_connected: number;
}

// Policies conferidas em 2026-09-03 (Dev). O teste de integração é quem mantém
// estas frases verdadeiras — não este comentário.
const EDITORS = {
  // organization_members_admin_writes; organizations não tem policy de escrita.
  organizacao: "Membros e papéis: ADMIN. Nome e slug da organização: sem tela — não editável na interface.",
  // replenishment_settings_{insert,update,delete}_admin: ADMIN e GESTOR.
  reposicao: "ADMIN e GESTOR.",
  // notification_preferences_all_own: user_id = auth.uid().
  notificacoes: "Cada usuário edita só as próprias preferências.",
  // ml_accounts_admin_inserts: ADMIN. Conectar exige o client_secret, que só a api tem.
  mercado_livre: "ADMIN cadastra e conecta.",
  // AI_MONTHLY_BUDGET_USD é variável do worker (D-100), definida no deploy.
  ia: "Ninguém pela interface: o teto é definido no deploy (D-100).",
  // reply_templates_* e knowledge_entries_update_admin: ADMIN e GESTOR gerenciam; qualquer membro sugere conhecimento.
  operacao: "ADMIN e GESTOR gerenciam; qualquer membro sugere entrada de conhecimento.",
  // saved_filters_select_own: created_by = auth.uid().
  preferencias: "Cada usuário edita só os próprios filtros salvos.",
} as const;

const INDISPONIVEL = "não foi possível ler — a tela dona mostra o estado real";

const LINKS = {
  organizacao: [{ label: "Usuários", href: "/usuarios" }],
  reposicao: [{ label: "Configuração de reposição", href: "/reposicao/configuracoes" }],
  notificacoes: [{ label: "Preferências de notificação", href: "/notificacoes/preferencias" }],
  mercado_livre: [
    { label: "Contas ML", href: "/contas" },
    { label: "Integrações", href: "/integracoes" },
  ],
  // Custo e uso de IA não têm tela dona (D-232): a Central de Integrações é
  // quem compõe o número; aqui só se diz onde o teto mora.
  ia: [
    { label: "Integrações", href: "/integracoes" },
    { label: "Copiloto", href: "/copiloto" },
  ],
  operacao: [
    { label: "Templates de resposta", href: "/atendimento/templates" },
    { label: "Base de conhecimento", href: "/atendimento/conhecimento" },
  ],
  preferencias: [{ label: "Vendas", href: "/vendas" }],
} as const satisfies Record<SettingsSection["id"], readonly SettingsLink[]>;

function plural(n: number, singular: string, plural: string): string {
  return `${String(n)} ${n === 1 ? singular : plural}`;
}

function secao(
  id: SettingsSection["id"],
  label: string,
  state: SettingState,
  summary: string,
  editors: string,
): SettingsSection {
  return { id, label, state, summary, editors, links: [...LINKS[id]] };
}

function indisponivel(id: SettingsSection["id"], label: string, editors: string): SettingsSection {
  return secao(id, label, "indisponivel", INDISPONIVEL, editors);
}

export function describeSettings(o: SettingsOverview | null): SettingsSection[] {
  const nomeDaOrganizacao = o?.organization_name ?? null;
  const organizacao =
    o === null || nomeDaOrganizacao === null
      ? indisponivel("organizacao", "Organização", EDITORS.organizacao)
      : secao(
          "organizacao",
          "Organização",
          "configurado",
          `${nomeDaOrganizacao} (${o.organization_slug ?? "—"}) — ${plural(o.members_total, "membro", "membros")}, ${plural(
            o.members_admin,
            "ADMIN",
            "ADMIN",
          )}`,
          EDITORS.organizacao,
        );

  let reposicao: SettingsSection;

  if (o === null) {
    reposicao = indisponivel("reposicao", "Reposição", EDITORS.reposicao);
  } else {
    const detalhe = `${plural(o.replenishment_brand, "regra por marca", "regras por marca")}, ${plural(
      o.replenishment_sku,
      "por SKU",
      "por SKU",
    )}`;

    // D-144: sem configuração aplicável a sugestão de compra RECUSA número.
    // Só regra por marca/SKU cobre parte do catálogo — o resto continua sem
    // resposta, e isso precisa estar dito, não somado.
    reposicao =
      o.replenishment_default > 0
        ? secao("reposicao", "Reposição", "configurado", `padrão da organização definido; ${detalhe}`, EDITORS.reposicao)
        : o.replenishment_brand + o.replenishment_sku > 0
          ? secao(
              "reposicao",
              "Reposição",
              "parcial",
              `sem padrão da organização — ${detalhe}; para o resto do catálogo a sugestão de compra recusa número`,
              EDITORS.reposicao,
            )
          : secao(
              "reposicao",
              "Reposição",
              "nao_configurado",
              "nenhuma política cadastrada — a sugestão de compra recusa número até haver uma",
              EDITORS.reposicao,
            );
  }

  let notificacoes: SettingsSection;

  if (o === null) {
    notificacoes = indisponivel("notificacoes", "Notificações", EDITORS.notificacoes);
  } else if (o.notification_prefs_mine === 0) {
    notificacoes = secao(
      "notificacoes",
      "Notificações",
      "nao_configurado",
      "nenhuma preferência sua — vale o padrão do sistema",
      EDITORS.notificacoes,
    );
  } else {
    const geral =
      o.notification_global_min_severity === null
        ? "sem regra geral"
        : `regra geral: mínimo ${o.notification_global_min_severity}${o.notification_global_enabled === false ? " (desligada)" : ""}`;

    notificacoes = secao(
      "notificacoes",
      "Notificações",
      "configurado",
      `${plural(o.notification_prefs_mine, "regra sua", "regras suas")}; ${geral}`,
      EDITORS.notificacoes,
    );
  }

  let mercadoLivre: SettingsSection;

  if (o === null) {
    mercadoLivre = indisponivel("mercado_livre", "Mercado Livre", EDITORS.mercado_livre);
  } else if (o.ml_accounts_total === 0) {
    mercadoLivre = secao("mercado_livre", "Mercado Livre", "nao_configurado", "nenhuma conta cadastrada", EDITORS.mercado_livre);
  } else {
    mercadoLivre = secao(
      "mercado_livre",
      "Mercado Livre",
      o.ml_accounts_connected === o.ml_accounts_total ? "configurado" : "parcial",
      `${String(o.ml_accounts_connected)} de ${plural(o.ml_accounts_total, "conta conectada", "contas conectadas")}`,
      EDITORS.mercado_livre,
    );
  }

  // Nunca "configurado" nem "não configurado": o teto EXISTE, mas mora fora
  // do alcance de qualquer tela — dizer isso é a informação útil. Uso e custo
  // do mês são compostos pela Central de Integrações, não repetidos aqui.
  const ia = secao(
    "ia",
    "IA / Copiloto",
    "nao_editavel",
    "teto mensal definido no deploy (AI_MONTHLY_BUDGET_USD, D-100); uso e custo do mês em Integrações",
    EDITORS.ia,
  );

  let operacao: SettingsSection;

  if (o === null) {
    operacao = indisponivel("operacao", "Operação (atendimento)", EDITORS.operacao);
  } else if (o.reply_templates === 0 && o.knowledge_entries === 0) {
    operacao = secao(
      "operacao",
      "Operação (atendimento)",
      "nao_configurado",
      "nenhum template de resposta e nenhuma entrada de conhecimento",
      EDITORS.operacao,
    );
  } else {
    operacao = secao(
      "operacao",
      "Operação (atendimento)",
      "configurado",
      `${plural(o.reply_templates, "template", "templates")}; ${plural(
        o.knowledge_entries,
        "entrada de conhecimento",
        "entradas de conhecimento",
      )} (${String(o.knowledge_validated)} validada(s))`,
      EDITORS.operacao,
    );
  }

  const preferencias =
    o === null
      ? indisponivel("preferencias", "Preferências", EDITORS.preferencias)
      : o.saved_filters_mine === 0
        ? secao("preferencias", "Preferências", "nao_configurado", "nenhum filtro salvo seu", EDITORS.preferencias)
        : secao(
            "preferencias",
            "Preferências",
            "configurado",
            `${plural(o.saved_filters_mine, "filtro salvo seu", "filtros salvos seus")} em Vendas`,
            EDITORS.preferencias,
          );

  return [organizacao, reposicao, notificacoes, mercadoLivre, ia, operacao, preferencias];
}
