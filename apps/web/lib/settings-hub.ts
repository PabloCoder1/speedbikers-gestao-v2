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
 *    vermelha aqui. Termo que a tela dona só mostra a ADMIN carrega
 *    `somenteAdmin`, e `incluiPara` o tira de quem não vai achá-lo.
 * 2. **`aviso`** — a consequência operacional, quando há uma. Cinco condições,
 *    todas leitura DIRETA de um dos 16 campos que a RPC já devolve: nenhuma
 *    inventa limiar e nenhuma precisa de campo novo. Toda frase termina na ação
 *    que a resolve e na tela onde se faz — e, para quem não pode agir, em
 *    "peça a um ADMIN que…": ação que o leitor não consegue fazer não é saída.
 *    `null` é o normal, e seção que não pôde ser lida nunca tem aviso.
 * 3. **`editorRoles`** — os papéis que a policy deixa alterar, em forma de
 *    DADO. É o que permite a `quemAltera` falar em segunda pessoa ("Você é
 *    ADMIN — pode alterar.") em vez da prosa impessoal. A cláusula das
 *    policies que os papéis não carregam ("qualquer membro sugere…", "o nome
 *    não se edita…") vai junto, em `ressalvaQuem`. A prosa de `EDITORS` é o
 *    que se diz quando não se sabe o papel de quem olha. Quem guarda a POLICY
 *    é o teste de integração
 *    `hub de configuracoes: quem altera bate com as policies (D-233)`, que lê
 *    `pg_policy` e afirma os fatos — ele não compara estas frases; a paridade
 *    entre as frases e os papéis é o teste de unidade que guarda.
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
  /**
   * A tela dona só mostra este termo a ADMIN (`isAdmin`, `ehAdmin`). Ensiná-lo
   * a outro papel é mandá-lo procurar um rótulo que ele não vai achar.
   */
  somenteAdmin?: true;
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
  /**
   * A cláusula das policies que `editorRoles` não carrega — "qualquer membro
   * sugere", "o nome não se edita". Sem ela, a frase em segunda pessoa diria
   * só a metade que cabe na lista de papéis.
   */
  ressalvaQuem: string | null;
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
// `pg_policies` de produção. O teste de integração mantém as POLICIES no
// lugar; estas frases são o que o operador lê quando o papel dele não pôde ser
// lido — por isso sem número de decisão e sem nome de coluna.
const EDITORS = {
  // organization_members_admin_writes; organizations não tem policy de escrita.
  organizacao: "Membros e papéis: ADMIN. Nome da organização: sem tela — não editável na interface.",
  // replenishment_settings_{insert,update,delete}_admin: ADMIN e GESTOR.
  reposicao: "ADMIN e GESTOR.",
  // notification_preferences_all_own: user_id = auth.uid().
  notificacoes: "Cada usuário edita só as próprias preferências.",
  // ml_accounts_admin_inserts: ADMIN. Conectar exige o client_secret, que só a api tem.
  mercado_livre: "ADMIN cadastra e conecta.",
  // AI_MONTHLY_BUDGET_USD é variável do worker (D-100), definida no deploy.
  ia: "Ninguém pela interface: o teto é definido no deploy.",
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
 * A segunda cláusula de `EDITORS`, que a lista de papéis não tem como dizer.
 * Vale para QUALQUER papel — por isso é uma frase à parte, acrescentada depois
 * da resposta em segunda pessoa, e não uma variação dela. O teste de paridade
 * exige uma ressalva aqui sempre que a prosa de `EDITORS` tiver cláusula
 * depois de ";" ou ".".
 */
const RESSALVA_QUEM: Partial<Record<SettingsSection["id"], string>> = {
  // organizations não tem policy de escrita: ADMIN altera membros e papéis, e
  // mais nada da organização.
  organizacao: "Vale para membros e papéis: o nome da organização não se edita na interface.",
  // knowledge_entries_insert_member: qualquer membro insere, como SUGERIDO.
  operacao: "Qualquer membro pode sugerir uma entrada de conhecimento.",
};

/**
 * O QUE cada área abrange, **no vocabulário da tela dona**, conferido arquivo
 * por arquivo em 2026-09-22. Trocar um rótulo na tela dona sem trocar aqui é o
 * que `scripts/check-settings-vocabulary.mjs` reprova.
 *
 * `somenteAdmin` marca o que a tela dona esconde de quem não é ADMIN — a
 * guarda confere que a string existe no arquivo, não para quem ela aparece, e
 * por isso a marca é conferida à mão contra a condição da tela dona, citada ao
 * lado de cada uma.
 */
export const INCLUI = {
  organizacao: [
    { termo: "Gerenciar acessos", arquivo: "app/usuarios/page.tsx" },
    // `...(isAdmin ? [{ label: "Convites pendentes" … }] : [])` na faixa.
    { termo: "Convites pendentes", arquivo: "app/usuarios/page.tsx", somenteAdmin: true },
    // `{isAdmin && (<Panel title="Histórico de acesso" …`.
    { termo: "Histórico de acesso", arquivo: "app/usuarios/page.tsx", somenteAdmin: true },
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
  mercado_livre: [
    // A célula da faixa de /contas, que todo papel vê: sem ela quem não é
    // ADMIN ficaria com a linha "Inclui:" vazia.
    { termo: "Contas cadastradas", arquivo: "app/contas/page.tsx" },
    // `{ehAdmin && (<Panel title="Conectar conta" …`.
    { termo: "Conectar conta", arquivo: "app/contas/page.tsx", somenteAdmin: true },
  ],
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
  // Sem âncora aqui: "Primeiros passos" só existe na tela dona quando não há
  // regra nenhuma, e é `describeSettings` quem a acrescenta nesse estado.
  reposicao: [{ label: "Configuração de reposição", href: "/reposicao/configuracoes" }],
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
    // "Revisão pendente": é a fila em que se valida. O aviso de conhecimento
    // não validado NÃO aponta para cá — a RPC não separa SUGERIDO de
    // REJEITADO/OBSOLETO, e a fila pode estar vazia; ele aponta para a base.
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
 * A zona em que a seção é impressa. O critério é PRESENÇA de configuração: a
 * zona 1 é o que ainda falta configurar (nada gravado, ou só parte), a 2 é o
 * que tem configuração, a 3 é o que não pôde ser lido. Cada rótulo de zona é
 * verdadeiro para as duas pílulas que ele abriga — assim zona e pílula não têm
 * como se contradizer. Nenhuma das três afirma saúde.
 */
export function zonaDe(state: SettingState): 1 | 2 | 3 {
  return ZONA[state];
}

function plural(n: number, singular: string, plural: string): string {
  return `${String(n)} ${n === 1 ? singular : plural}`;
}

function listarPapeis(papeis: readonly string[]): string {
  if (papeis.length <= 1) return papeis[0] ?? "ADMIN";

  return `${papeis.slice(0, -1).join(", ")} ou ${papeis[papeis.length - 1] ?? ""}`;
}

/**
 * O fim de um aviso: a ação que o resolve, no imperativo, para quem pode
 * fazê-la — e, para quem não pode, o pedido a quem pode.
 *
 * A ação é escrita no imperativo de terceira pessoa ("promova", "reconecte"),
 * que em português é também o subjuntivo: a mesma palavra serve às duas
 * frases ("promova um segundo ADMIN" / "peça a um ADMIN que promova um
 * segundo ADMIN"). `papel === null` é quem chama sem saber o papel (o teste,
 * ou uma tela futura): aí vale o imperativo, como antes.
 */
function comSaida(fato: string, acao: string, quemPode: EditorRoles, papel: string | null): string {
  if (papel === null || typeof quemPode === "string" || quemPode.includes(papel)) return `${fato} — ${acao}.`;

  return `${fato} — peça a um ${listarPapeis(quemPode)} que ${acao}.`;
}

/**
 * A consequência operacional, quando há uma — cada condição é leitura direta
 * de um dos 16 campos da RPC de hoje. Sem leitura não há aviso: `o === null` é
 * "não sei", e "não sei" não vira alerta (D-067).
 *
 * **Quem pode agir é o `editorRoles` da própria seção**: reconectar conta e
 * promover ADMIN são só ADMIN (`/contas`, `/usuarios`), validar conhecimento é
 * ADMIN ou GESTOR (`canManage` em `/atendimento/conhecimento`). Mandar um
 * ANALISTA "promover um segundo ADMIN" logo acima de "Quem altera: peça a um
 * ADMIN" era dar a saída a quem não tem a chave.
 */
export function avisoDe(
  o: SettingsOverview | null,
  id: SettingsSection["id"],
  papel: string | null = null,
): string | null {
  if (o === null) return null;

  const quemPode = EDITOR_ROLES[id];

  /*
    "Nem reposição" saiu das duas frases de ADMIN: as policies de
    `replenishment_settings` deixam ADMIN **e GESTOR** escrever, então uma
    organização com um GESTOR continua alterando a reposição sem ADMIN
    nenhum. A RPC não conta GESTOR, e a frase que se sustenta sem esse campo é
    a que fala só do que é exclusivo de ADMIN: membros e contas do Mercado
    Livre.
  */
  if (id === "organizacao") {
    // Inalcançável pela interface: o gatilho `guard_last_admin` (D-175) recusa
    // rebaixar ou remover o último ADMIN. Se aparecer, é porque alguém mexeu
    // por fora — e por fora é o único lugar onde se conserta: nenhuma tela
    // designa ADMIN sem um ADMIN.
    if (o.members_admin === 0) {
      return "Nenhum ADMIN na organização: ninguém altera membros nem contas do Mercado Livre, e nenhuma tela consegue designar um — o conserto é direto no banco.";
    }

    // Um ADMIN só numa organização de várias pessoas é ponto único de falha; com
    // uma pessoa só, é simplesmente o dono — e aviso que não tem ação vira ruído.
    if (o.members_admin === 1 && o.members_total > 1) {
      return comSaida(
        "Só uma pessoa é ADMIN. Se ela perder o acesso, ninguém altera membros nem contas do Mercado Livre",
        "promova um segundo ADMIN em Usuários",
        quemPode,
        papel,
      );
    }

    return null;
  }

  if (id === "mercado_livre" && o.ml_accounts_connected < o.ml_accounts_total) {
    return comSaida(
      "Conta desconectada não sincroniza: pedidos, perguntas e mensagens novos dela não chegam",
      "reconecte a conta em Contas ML",
      quemPode,
      papel,
    );
  }

  // `'self'`: a regra geral é de quem olha, e só ele a liga.
  if (id === "notificacoes" && o.notification_global_enabled === false) {
    return comSaida(
      "A sua regra geral está desligada: nenhum alerta sai por ela",
      "ligue-a em Preferências de notificação",
      quemPode,
      papel,
    );
  }

  /*
    `copilot-generation.ts` filtra `status = 'VALIDADO'` ao montar a evidência:
    base sem nenhuma entrada validada não chega ao Copiloto.

    A saída é a BASE, não a fila "Revisão pendente": a RPC conta todas as
    entradas e, à parte, só as VALIDADO — três entradas recusadas ou
    arquivadas dão a mesma leitura que três sugeridas, e aí a fila de
    sugeridas está vazia.
  */
  if (id === "operacao" && o.knowledge_entries > 0 && o.knowledge_validated === 0) {
    return comSaida(
      "Nenhuma entrada validada: o Copiloto só usa o que está VALIDADO, então a base ainda não chega nele",
      "revise as entradas na Base de conhecimento",
      quemPode,
      papel,
    );
  }

  return null;
}

/**
 * "Quem altera", em segunda pessoa — a pergunta do operador é "EU posso?", e a
 * prosa impessoal ("ADMIN e GESTOR.") o obriga a lembrar o próprio papel.
 *
 * A `ressalvaQuem` vem sempre depois, para qualquer papel: é a parte da policy
 * que a lista de papéis não diz ("qualquer membro pode sugerir", "o nome não se
 * edita"), e sem ela a frase diria só a metade.
 *
 * Sem papel conhecido a resposta volta a ser a de `EDITORS`: sem saber quem
 * pergunta, a única frase verdadeira é a impessoal.
 */
export function quemAltera(secao: SettingsSection, role: string | null): string {
  if (role === null) return secao.editors;

  const papeis = secao.editorRoles;

  if (papeis === "none") return "Ninguém pela interface — o teto é definido no deploy.";

  // A concordância segue o objeto de cada área: preferências de notificação são
  // "as suas"; filtros salvos são "os seus".
  if (papeis === "self") return secao.id === "preferencias" ? "Só você altera os seus." : "Só você altera as suas.";

  const resposta = papeis.includes(role) ? `Você é ${role} — pode alterar.` : `Você é ${role} — peça a um ${listarPapeis(papeis)}.`;

  return secao.ressalvaQuem === null ? resposta : `${resposta} ${secao.ressalvaQuem}`;
}

/**
 * Os termos de "Inclui:" que QUEM OLHA vai achar na tela dona.
 *
 * A guarda de vocabulário confere que a string existe no arquivo, não para
 * quem ela aparece: "Convites pendentes" existe em /usuarios, mas só para
 * ADMIN. Sem papel conhecido, todos — é a descrição da área, não uma promessa
 * a alguém em particular.
 */
export function incluiPara(secao: SettingsSection, papel: string | null): readonly TermoDaTelaDona[] {
  if (papel === null || papel === "ADMIN") return secao.inclui;

  return secao.inclui.filter((termo) => termo.somenteAdmin !== true);
}

/**
 * A faixa da tela: o total e as CINCO partes, sobre o mesmo array que os
 * cartões imprimem (D-265).
 *
 * **Sem leitura, as três partes que dependem dela são `null`** — "—" na tela,
 * não zero. Zero ali se lê "nada está configurado", que é o oposto do que
 * aconteceu (D-067). As outras três continuam SABIDAS: o total é o tamanho do
 * conjunto, a IA é "não editável aqui" com ou sem banco, e as indisponíveis
 * são justamente as que a leitura derrubou. Neste ramo a invariante "as cinco
 * partes somam o total" deixa de valer, de propósito.
 */
export interface PlacarDaFaixa {
  secoes: number;
  configuradas: number | null;
  parciais: number | null;
  naoConfiguradas: number | null;
  naoEditaveis: number;
  indisponiveis: number;
}

function contar(secoes: readonly SettingsSection[], estado: SettingState): number {
  return secoes.filter((secao) => secao.state === estado).length;
}

export function placarDe(secoes: readonly SettingsSection[], semLeitura: boolean): PlacarDaFaixa {
  const sabida = (estado: SettingState): number | null => (semLeitura ? null : contar(secoes, estado));

  return {
    secoes: secoes.length,
    configuradas: sabida("configurado"),
    parciais: sabida("parcial"),
    naoConfiguradas: sabida("nao_configurado"),
    naoEditaveis: contar(secoes, "nao_editavel"),
    indisponiveis: contar(secoes, "indisponivel"),
  };
}

/**
 * O veredito do subtítulo, com AS MESMAS DUAS CONTAGENS que a faixa mostra em
 * "Não configuradas" e "Parciais" — um placar só, dito duas vezes com as
 * mesmas palavras. Contar as duas juntas como "não têm configuração" era dizer
 * que uma área parcial não tem configuração nenhuma, com a célula "Parciais"
 * logo abaixo dizendo outra coisa.
 *
 * `null` quando qualquer parte não pôde ser lida: veredito não se inventa
 * (D-067), e "As 7 áreas têm configuração" sobre uma zona "NÃO FOI POSSÍVEL
 * LER" seria a invenção mais fácil de todas.
 */
export function vereditoDe(secoes: readonly SettingsSection[], semLeitura: boolean): string | null {
  if (semLeitura || secoes.some((secao) => secao.state === "indisponivel")) return null;

  const total = String(secoes.length);
  const sem = contar(secoes, "nao_configurado");
  const parciais = contar(secoes, "parcial");
  const verboParcial = parciais === 1 ? "tem" : "têm";

  if (sem === 0 && parciais === 0) return `As ${total} áreas têm configuração.`;

  if (sem === 0) return `${String(parciais)} das ${total} áreas ${verboParcial} configuração parcial.`;

  const semFrase =
    sem === 1 ? `1 das ${total} áreas ainda não tem configuração` : `${String(sem)} das ${total} áreas ainda não têm configuração`;

  if (parciais === 0) return `${semFrase}.`;

  return `${semFrase} e ${String(parciais)} ${verboParcial} configuração parcial.`;
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
    ressalvaQuem: RESSALVA_QUEM[id] ?? null,
  };
}

function indisponivel(id: SettingsSection["id"], label: string): SettingsSection {
  return secao(id, label, "indisponivel", INDISPONIVEL);
}

/**
 * As sete seções, na ordem do ROADMAP. `papel` é o de quem olha (`null` quando
 * não se sabe): ele só muda o FIM dos avisos — a ação para quem pode, o pedido
 * para quem não pode —, nunca o estado nem o resumo.
 */
export function describeSettings(lida: SettingsOverview | null, papel: string | null = null): SettingsSection[] {
  /*
    Nome NULL é o contrato de `get_settings_overview` para a organização que a
    RLS esconde: nome NULL e TODAS as contagens em zero, não erro. Zero ali é
    "não sei" em todas as seções — não só na Organização —, e tratá-lo como
    leitura faria cinco áreas aparecerem "não configuradas" com o banco
    escondendo a resposta (D-067). É a mesma resposta de uma leitura que
    falhou, e é tratada como tal.
  */
  const o = lida !== null && lida.organization_name !== null ? lida : null;
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
          : {
              ...secao(
                "reposicao",
                "Reposição",
                "nao_configurado",
                "Nenhuma política cadastrada — a sugestão de compra recusa número até haver uma.",
              ),
              // A seção "Primeiros passos" da tela dona só existe quando não há
              // regra nenhuma (`regras.length === 0` em
              // `reposicao/configuracoes/page.tsx`) — é exatamente este estado.
              // Em qualquer outro a âncora apontaria para o nada.
              links: [{ label: "Configuração de reposição", href: "/reposicao/configuracoes#cfg-comeco-titulo" }],
            };
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
  //
  // Seção INDISPONÍVEL nunca tem aviso: o que ela diria viria de uma leitura
  // que não houve. A organização escondida já cai em `o === null` acima;
  // esta regra é a que continua valendo se um dia uma seção ficar
  // indisponível sozinha. Alarme feito de "não sei" é o que D-067 proíbe.
  return [organizacao, reposicao, notificacoes, mercadoLivre, ia, operacao, preferencias].map((s) => ({
    ...s,
    aviso: s.state === "indisponivel" ? null : avisoDe(o, s.id, papel),
  }));
}
