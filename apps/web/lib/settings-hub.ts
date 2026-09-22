/**
 * Hub de Configurações (D-233) — a peça PURA de `/configuracoes`, no padrão de
 * `lib/integrations.ts`: recebe UMA linha de `get_settings_overview` (todas
 * as contagens já feitas no banco, sob a RLS de quem pergunta) e devolve as
 * sete seções que o item do ROADMAP lista —
 * `Organização | Reposição | Notificações | Mercado Livre | IA/Copiloto | Operação | Preferências` —
 * cada uma com o resumo do que existe, O QUE a área abrange, a consequência
 * quando há uma, QUEM altera e ONDE.
 *
 * A decisão registrada no item era "embutir ou apontar". A resposta é APONTAR,
 * e este módulo é a razão de a resposta ser segura: ele não sabe editar nada.
 * Um dado, um dono (D-224) — a tela dona continua sendo a única com formulário
 * e a única que valida. Zero cópia divergente porque não há cópia: só leitura
 * e link.
 *
 * ## As três coisas que este módulo passou a fazer, e o que guarda cada uma
 *
 * 1. **`inclui`** — o que a área abrange, no VOCABULÁRIO LITERAL da tela dona.
 *    Uma quarta redação dos mesmos campos apodreceria em silêncio, que é D-224
 *    em forma de texto; por isso cada termo carrega o arquivo onde ele existe e
 *    `pnpm --filter @sb/web check:settings-vocabulary` confere, a cada CI, que
 *    a string literal continua lá. Trocou o rótulo na tela dona, a guarda fica
 *    vermelha aqui.
 * 2. **`aviso`** — a consequência operacional, quando há uma. Cinco condições,
 *    todas leitura DIRETA de um dos 16 campos que a RPC já devolve: nenhuma
 *    inventa limiar e nenhuma precisa de campo novo. Toda frase termina na ação
 *    que a resolve e na tela onde se faz — alarme que o dono não pode apagar
 *    vira mobília. `null` é o normal.
 * 3. **`editorRoles`** — os papéis que a policy deixa alterar, em forma de
 *    DADO. É o que permite a `quemAltera` falar em segunda pessoa ("Você é
 *    ADMIN — pode alterar.") em vez da prosa impessoal. A prosa de `EDITORS`
 *    continua aqui, **verbatim**, como o que se diz quando não se sabe o papel
 *    de quem olha, e o teste de integração
 *    `hub de configuracoes: quem altera bate com as policies (D-233)` confere
 *    as policies contra `pg_policy` a cada CI.
 */

import { severityLabel } from "./labels";

export type SettingState = "configurado" | "parcial" | "nao_configurado" | "nao_editavel" | "indisponivel";

export interface SettingsLink {
  label: string;
  href: string;
}

/** Um termo do vocabulário da tela dona, com o arquivo onde a guarda o procura. */
export interface TermoDaTelaDona {
  /** A palavra como a tela dona a escreve, caractere a caractere. */
  termo: string;
  /** O arquivo onde a guarda vai procurar o termo, a partir de `apps/web`. */
  arquivo: string;
}

/**
 * Papéis que a policy deixa alterar; `'self'` é `auth.uid()` (só o dono da
 * linha) e `'none'` é "não existe caminho pela interface".
 */
export type EditorRoles = readonly string[] | "self" | "none";

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
  /** Vocabulário LITERAL da tela dona. Guardado por `check:settings-vocabulary`. */
  inclui: readonly TermoDaTelaDona[];
  /** Consequência medida, quando há. Nunca inventada; `null` é o normal. */
  aviso: string | null;
  /** Papéis que a policy deixa alterar, ou `'self'` (auth.uid()) ou `'none'`. */
  editorRoles: EditorRoles;
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

// Policies conferidas em 2026-09-03 (Dev) e reconferidas em 2026-09-22 contra
// `pg_policies` de produção. O teste de integração é quem mantém estas frases
// verdadeiras — não este comentário.
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

/**
 * A MESMA verdade de `EDITORS`, em forma de dado — é daqui que sai a frase em
 * segunda pessoa. As duas listas podem divergir num ajuste futuro; quem guarda
 * a policy é o teste de integração, que lê `pg_policy` e não compara as duas.
 */
const EDITOR_ROLES = {
  organizacao: ["ADMIN"],
  reposicao: ["ADMIN", "GESTOR"],
  notificacoes: "self",
  mercado_livre: ["ADMIN"],
  ia: "none",
  operacao: ["ADMIN", "GESTOR"],
  preferencias: "self",
} as const satisfies Record<SettingsSection["id"], EditorRoles>;

/**
 * O QUE cada área abrange, **no vocabulário da tela dona**, conferido arquivo
 * por arquivo em 2026-09-22. Trocar um rótulo na tela dona sem trocar aqui é o
 * que `scripts/check-settings-vocabulary.mjs` reprova.
 */
export const INCLUI = {
  organizacao: [
    { termo: "Gerenciar acessos", arquivo: "app/usuarios/page.tsx" },
    { termo: "Convites pendentes", arquivo: "app/usuarios/page.tsx" },
    { termo: "Histórico de acesso", arquivo: "app/usuarios/page.tsx" },
  ],
  reposicao: [
    { termo: "Prazo do fornecedor", arquivo: "app/reposicao/configuracoes/page.tsx" },
    { termo: "Cobertura desejada", arquivo: "app/reposicao/configuracoes/page.tsx" },
    { termo: "Segurança", arquivo: "app/reposicao/configuracoes/page.tsx" },
    { termo: "Teto", arquivo: "app/reposicao/configuracoes/page.tsx" },
  ],
  notificacoes: [
    { termo: "Regras de alerta", arquivo: "app/notificacoes/preferencias/page.tsx" },
    { termo: "Severidade mínima", arquivo: "app/notificacoes/preferencias/new-preference-form.tsx" },
  ],
  mercado_livre: [{ termo: "Conectar conta", arquivo: "app/contas/page.tsx" }],
  // A IA não tem tela dona (D-232): quem compõe uso e custo é a Central de
  // Integrações, e é o item do menu que leva até ela.
  ia: [{ termo: "Integrações", arquivo: "components/nav.tsx" }],
  operacao: [
    { termo: "Templates de resposta", arquivo: "app/atendimento/templates/page.tsx" },
    { termo: "Revisão pendente", arquivo: "app/atendimento/conhecimento/page.tsx" },
  ],
  preferencias: [{ termo: "Salvar visão", arquivo: "components/saved-filters.tsx" }],
} as const satisfies Record<SettingsSection["id"], readonly TermoDaTelaDona[]>;

const INDISPONIVEL = "Não foi possível ler — a tela dona mostra o estado real.";

const LINKS = {
  organizacao: [{ label: "Usuários", href: "/usuarios" }],
  // Âncora da seção "Primeiros passos" (`reposicao/configuracoes/page.tsx`, o
  // `id` do h2): quem chega daqui chega na explicação, não no meio da lista.
  reposicao: [{ label: "Configuração de reposição", href: "/reposicao/configuracoes#cfg-comeco-titulo" }],
  notificacoes: [{ label: "Preferências de notificação", href: "/notificacoes/preferencias" }],
  mercado_livre: [
    { label: "Contas ML", href: "/contas" },
    { label: "Integrações", href: "/integracoes" },
  ],
  // Custo e uso de IA não têm tela dona (D-232): a Central de Integrações é
  // quem compõe o número; aqui só se diz onde o teto mora.
  ia: [
    { label: "Uso e custo em Integrações", href: "/integracoes" },
    { label: "Copiloto", href: "/copiloto" },
  ],
  operacao: [
    { label: "Templates de resposta", href: "/atendimento/templates" },
    { label: "Base de conhecimento", href: "/atendimento/conhecimento" },
    // `?status=SUGERIDO` é lido pela tela e o painel passa a se chamar
    // "Revisão pendente": é para onde aponta o aviso de conhecimento não
    // validado, e é a fila em que se age.
    { label: "Revisão pendente", href: "/atendimento/conhecimento?status=SUGERIDO" },
  ],
  // DUAS telas, não uma. `saved_filters_mine` conta sem filtrar `screen`, e
  // `SavedFilters` está montado em `vendas/page.tsx` E em `anuncios/page.tsx`:
  // dizer "em Vendas" seria falso no primeiro filtro salvo em /anúncios.
  preferencias: [
    { label: "Vendas", href: "/vendas" },
    { label: "Anúncios", href: "/anuncios" },
  ],
} as const satisfies Record<SettingsSection["id"], readonly SettingsLink[]>;

/** `parcial|nao_configurado` → 1; `configurado|nao_editavel` → 2; `indisponivel` → 3. */
const ZONA: Record<SettingState, 1 | 2 | 3> = {
  parcial: 1,
  nao_configurado: 1,
  configurado: 2,
  nao_editavel: 2,
  indisponivel: 3,
};

/**
 * A zona em que a seção é impressa. O critério é PRESENÇA de configuração, que
 * é exatamente o que a pílula do cartão diz — assim zona e pílula não têm como
 * se contradizer. Nenhuma das três afirma saúde.
 */
export function zonaDe(state: SettingState): 1 | 2 | 3 {
  return ZONA[state];
}

function plural(n: number, singular: string, plural: string): string {
  return `${String(n)} ${n === 1 ? singular : plural}`;
}

/**
 * A consequência operacional, quando há uma — cada condição é leitura direta
 * de um dos 16 campos da RPC de hoje. Sem leitura não há aviso: `o === null` é
 * "não sei", e "não sei" não vira alerta (D-067).
 */
export function avisoDe(o: SettingsOverview | null, id: SettingsSection["id"]): string | null {
  if (o === null) return null;

  if (id === "organizacao") {
    if (o.members_admin === 0) {
      return "Nenhum ADMIN na organização: ninguém altera membros, contas do Mercado Livre nem reposição. Um ADMIN precisa ser designado em Usuários.";
    }

    // Um ADMIN só numa organização de várias pessoas é ponto único de falha; com
    // uma pessoa só, é simplesmente o dono — e aviso que não tem ação vira ruído.
    if (o.members_admin === 1 && o.members_total > 1) {
      return "Só uma pessoa é ADMIN. Se ela perder o acesso, ninguém altera membros, contas do Mercado Livre nem reposição — promova um segundo ADMIN em Usuários.";
    }

    return null;
  }

  if (id === "mercado_livre" && o.ml_accounts_connected < o.ml_accounts_total) {
    return "Conta desconectada não sincroniza: pedidos, perguntas e mensagens novos dela não chegam — reconecte a conta em Contas ML.";
  }

  if (id === "notificacoes" && o.notification_global_enabled === false) {
    return "A sua regra geral está desligada: nenhum alerta sai por ela — ligue-a em Preferências de notificação.";
  }

  // `copilot-generation.ts` filtra `status = 'VALIDADO'` ao montar a evidência:
  // base inteira em SUGERIDO não chega ao Copiloto.
  if (id === "operacao" && o.knowledge_entries > 0 && o.knowledge_validated === 0) {
    return "Nenhuma entrada validada: o Copiloto só usa o que está VALIDADO, então a base ainda não chega nele — valide as entradas em Revisão pendente.";
  }

  return null;
}

function listarPapeis(papeis: readonly string[]): string {
  if (papeis.length <= 1) return papeis[0] ?? "ADMIN";

  return `${papeis.slice(0, -1).join(", ")} ou ${papeis[papeis.length - 1] ?? ""}`;
}

/**
 * "Quem altera", em segunda pessoa — a pergunta do operador é "EU posso?", e a
 * prosa impessoal ("ADMIN e GESTOR.") o obriga a lembrar o próprio papel.
 *
 * Sem papel conhecido a resposta volta a ser a de `EDITORS`, **verbatim**: sem
 * saber quem pergunta, a única frase verdadeira é a impessoal.
 */
export function quemAltera(secao: SettingsSection, role: string | null): string {
  if (role === null) return secao.editors;

  const papeis = secao.editorRoles;

  if (papeis === "none") return "Ninguém pela interface — o teto é definido no deploy.";

  // A concordância segue o objeto de cada área: preferências de notificação são
  // "as suas"; filtros salvos são "os seus".
  if (papeis === "self") return secao.id === "preferencias" ? "Só você altera os seus." : "Só você altera as suas.";

  if (papeis.includes(role)) return `Você é ${role} — pode alterar.`;

  return `Você é ${role} — peça a um ${listarPapeis(papeis)}.`;
}

function secao(id: SettingsSection["id"], label: string, state: SettingState, summary: string): SettingsSection {
  return {
    id,
    label,
    state,
    summary,
    editors: EDITORS[id],
    links: [...LINKS[id]],
    inclui: [...INCLUI[id]],
    aviso: null,
    editorRoles: EDITOR_ROLES[id],
  };
}

function indisponivel(id: SettingsSection["id"], label: string): SettingsSection {
  return secao(id, label, "indisponivel", INDISPONIVEL);
}

export function describeSettings(o: SettingsOverview | null): SettingsSection[] {
  const nomeDaOrganizacao = o?.organization_name ?? null;
  const organizacao =
    o === null || nomeDaOrganizacao === null
      ? indisponivel("organizacao", "Organização")
      : secao(
          "organizacao",
          "Organização",
          "configurado",
          `${nomeDaOrganizacao} (${o.organization_slug ?? "—"}) — ${plural(o.members_total, "membro", "membros")}, ${plural(
            o.members_admin,
            "ADMIN",
            "ADMIN",
          )}.`,
        );

  let reposicao: SettingsSection;

  if (o === null) {
    reposicao = indisponivel("reposicao", "Reposição");
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
        ? secao("reposicao", "Reposição", "configurado", `Padrão da organização definido; ${detalhe}.`)
        : o.replenishment_brand + o.replenishment_sku > 0
          ? secao(
              "reposicao",
              "Reposição",
              "parcial",
              `Sem padrão da organização — ${detalhe}; para o resto do catálogo a sugestão de compra recusa número.`,
            )
          : secao(
              "reposicao",
              "Reposição",
              "nao_configurado",
              "Nenhuma política cadastrada — a sugestão de compra recusa número até haver uma.",
            );
  }

  let notificacoes: SettingsSection;

  if (o === null) {
    notificacoes = indisponivel("notificacoes", "Notificações");
  } else if (o.notification_prefs_mine === 0) {
    notificacoes = secao(
      "notificacoes",
      "Notificações",
      "nao_configurado",
      "Nenhuma preferência sua — vale o padrão do sistema.",
    );
  } else {
    // O código do banco ("critico") não é o nome do produto: quem rotula é
    // `severityLabel`, a mesma função que a Central de Notificações usa.
    const geral =
      o.notification_global_min_severity === null
        ? "sem regra geral"
        : `regra geral: mínimo ${severityLabel(o.notification_global_min_severity)}${
            o.notification_global_enabled === false ? " (desligada)" : ""
          }`;

    notificacoes = secao(
      "notificacoes",
      "Notificações",
      "configurado",
      `${plural(o.notification_prefs_mine, "regra sua", "regras suas")}; ${geral}.`,
    );
  }

  let mercadoLivre: SettingsSection;

  if (o === null) {
    mercadoLivre = indisponivel("mercado_livre", "Mercado Livre");
  } else if (o.ml_accounts_total === 0) {
    mercadoLivre = secao("mercado_livre", "Mercado Livre", "nao_configurado", "Nenhuma conta cadastrada.");
  } else {
    mercadoLivre = secao(
      "mercado_livre",
      "Mercado Livre",
      o.ml_accounts_connected === o.ml_accounts_total ? "configurado" : "parcial",
      `${String(o.ml_accounts_connected)} de ${plural(o.ml_accounts_total, "conta conectada", "contas conectadas")}.`,
    );
  }

  // Nunca "configurado" nem "não configurado": o teto EXISTE, mas mora fora
  // do alcance de qualquer tela — dizer isso é a informação útil. Uso e custo
  // do mês são compostos pela Central de Integrações, não repetidos aqui.
  //
  // O nome da variável de ambiente e o número da decisão saíram da frase: quem
  // lê esta tela é o operador, e nenhum dos dois o ajuda a fazer nada. O teto é
  // `AI_MONTHLY_BUDGET_USD`, definido no deploy (D-100).
  const ia = secao(
    "ia",
    "IA / Copiloto",
    "nao_editavel",
    "Teto mensal de gasto definido no deploy, fora do produto; uso e custo do mês em Integrações.",
  );

  let operacao: SettingsSection;

  if (o === null) {
    operacao = indisponivel("operacao", "Operação (atendimento)");
  } else if (o.reply_templates === 0 && o.knowledge_entries === 0) {
    operacao = secao(
      "operacao",
      "Operação (atendimento)",
      "nao_configurado",
      "Nenhum template de resposta e nenhuma entrada de conhecimento.",
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
      )} (${plural(o.knowledge_validated, "validada", "validadas")}).`,
    );
  }

  const preferencias =
    o === null
      ? indisponivel("preferencias", "Preferências")
      : o.saved_filters_mine === 0
        ? secao("preferencias", "Preferências", "nao_configurado", "Nenhum filtro salvo seu.")
        : secao(
            "preferencias",
            "Preferências",
            "configurado",
            `${plural(o.saved_filters_mine, "filtro salvo seu", "filtros salvos seus")}.`,
          );

  // A ORDEM é a do ROADMAP e não muda: quem reordena para a leitura é a tela,
  // por zona, e o teste de unidade fixa esta ordem aqui.
  return [organizacao, reposicao, notificacoes, mercadoLivre, ia, operacao, preferencias].map((s) => ({
    ...s,
    aviso: avisoDe(o, s.id),
  }));
}
