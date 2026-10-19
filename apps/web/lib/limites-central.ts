import { MARGEM_MINIMA } from "./faturamento";
import type { createClient } from "./supabase/server";
import { numeroDigitado, type Leitura } from "./metas-imposto";
import { LIMITES_DA_VARIACAO, type LimitesDaVariacao } from "./variacao";

/**
 * Os limites que julgam os números da central (D-408). D-148: limiar é
 * decisão do dono, não constante -- por isso moram em `central_thresholds`,
 * uma linha por organização. Sem linha, valem os padrões, que são os números
 * que o código usava antes: nada muda até alguém mudar.
 */
export interface LimitesDaCentral {
  /** Estável abaixo de `neutro`; contra o indicador, atenção até `forte` e perigo acima. */
  readonly variacao: LimitesDaVariacao;
  /** Abaixo do esperado da meta até esta fração é atenção; mais que isso, perigo. */
  readonly atrasoDaMeta: number;
  /** Margem estimada depois do Ads abaixo disto: não escalar antes de revisar custos. */
  readonly margemAposAdsBaixa: number;
  /** Menos pedidos cobertos que isto em um dos períodos: a razão não é comparada. */
  readonly amostraMinima: number;
  /** Margem mínima dos produtos (D-410): abaixo dela, atenção e a lista de menor margem. */
  readonly margemMinima: number;
  /** Fração da meta de ROAS abaixo da qual a campanha está "abaixo da meta" (D-410). */
  readonly roasPisoDaMeta: number;
  /** `false` = os padrões (sem linha, ou a leitura falhou). */
  readonly personalizados: boolean;
}

export const LIMITES_PADRAO: LimitesDaCentral = {
  variacao: LIMITES_DA_VARIACAO,
  atrasoDaMeta: 0.05,
  margemAposAdsBaixa: 0.1,
  amostraMinima: 20,
  margemMinima: MARGEM_MINIMA,
  roasPisoDaMeta: 0.8,
  personalizados: false,
};

function numero(r: Record<string, unknown>, chave: string): number | null {
  const v = r[chave];
  const n = typeof v === "string" ? Number(v) : v;

  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * A linha de `central_thresholds` → limites. Linha ausente ou fora da forma
 * volta aos padrões: julgar com o limite de antes é melhor que não julgar.
 */
export function lerLimites(linha: unknown): LimitesDaCentral {
  if (linha === null || typeof linha !== "object") return LIMITES_PADRAO;

  const r = linha as Record<string, unknown>;
  const valores = [
    numero(r, "change_neutral"),
    numero(r, "change_strong"),
    numero(r, "points_neutral"),
    numero(r, "points_strong"),
    numero(r, "goal_delay_warning"),
    numero(r, "margin_after_ads_low"),
    numero(r, "min_orders_sample"),
  ];

  if (valores.some((v) => v === null)) return LIMITES_PADRAO;

  const [vn, vf, pn, pf, atraso, margem, amostra] = valores as [number, number, number, number, number, number, number];

  // D-410: colunas que chegaram depois. Ausentes (banco anterior à migration),
  // valem os padrões -- sem descartar os limites que a organização já salvou.
  return {
    variacao: { valor: { neutro: vn, forte: vf }, fracao: { neutro: pn, forte: pf } },
    atrasoDaMeta: atraso,
    margemAposAdsBaixa: margem,
    amostraMinima: amostra,
    margemMinima: numero(r, "margin_floor") ?? LIMITES_PADRAO.margemMinima,
    roasPisoDaMeta: numero(r, "ads_roas_floor") ?? LIMITES_PADRAO.roasPisoDaMeta,
    personalizados: true,
  };
}

type Supabase = Awaited<ReturnType<typeof createClient>>;

/**
 * Nunca rejeita: sem organização, sem linha ou com erro (inclusive a tabela
 * ainda não existir, com a web publicada antes da migration), os padrões.
 */
export async function carregarLimites(supabase: Supabase, organizationId: string | null): Promise<LimitesDaCentral> {
  if (organizationId === null) return LIMITES_PADRAO;

  try {
    const { data, error } = await supabase
      .from("central_thresholds")
      // Todas as colunas: as de D-410 podem ainda não existir no banco, e pedi-las
      // pelo nome faria a leitura falhar e descartar os limites já salvos.
      .select("*")
      .eq("organization_id", organizationId)
      .maybeSingle();

    return error === null ? lerLimites(data) : LIMITES_PADRAO;
  } catch {
    return LIMITES_PADRAO;
  }
}

/** Os campos do formulário, na ordem em que a tela os mostra. */
export const CAMPOS_DOS_LIMITES = [
  "change_neutral",
  "change_strong",
  "points_neutral",
  "points_strong",
  "goal_delay_warning",
  "margin_floor",
  "margin_after_ads_low",
  "ads_roas_floor",
  "min_orders_sample",
] as const;

export type CampoDosLimites = (typeof CAMPOS_DOS_LIMITES)[number];

export type ValoresDosLimites = Readonly<Record<CampoDosLimites, number>>;

/** Os limites como o banco guarda (frações e a amostra inteira). */
export function valoresDosLimites(l: LimitesDaCentral): ValoresDosLimites {
  return {
    change_neutral: l.variacao.valor.neutro,
    change_strong: l.variacao.valor.forte,
    points_neutral: l.variacao.fracao.neutro,
    points_strong: l.variacao.fracao.forte,
    goal_delay_warning: l.atrasoDaMeta,
    margin_floor: l.margemMinima,
    margin_after_ads_low: l.margemAposAdsBaixa,
    ads_roas_floor: l.roasPisoDaMeta,
    min_orders_sample: l.amostraMinima,
  };
}

const PORCENTAGEM = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });

const DIGITADO = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2, useGrouping: false });

/** O valor como a pessoa escreve no formulário: 0.02 → "2", 0.005 → "0,5", a amostra inteira. */
export function comoDigitado(campo: CampoDosLimites, valor: number): string {
  return campo === "min_orders_sample" ? String(valor) : DIGITADO.format(valor * 100);
}

interface TextoDoLimite {
  readonly rotulo: string;
  readonly dica: string;
  /**
   * O que o limite controla, onde vale e o efeito de subir ou baixar
   * (UX_SYSTEM §6, bloco 2) -- conferido nas regras de cada tela, não suposto.
   */
  readonly ajuda: string;
}

const TEXTOS: Readonly<Record<CampoDosLimites, TextoDoLimite>> = {
  change_neutral: {
    rotulo: "Variação estável (%)",
    dica: "Faturamento, pedidos, ticket, frete… que mudam menos que isto contra o período anterior ficam sem cor.",
    ajuda:
      "Vale para os indicadores em reais ou em quantidade (faturamento, pedidos, ticket, frete, investimento), comparados com o período anterior. Uma mudança menor que este percentual fica sem cor, mesmo quando é boa, e não entra no resumo. Aumentar deixa mais indicadores sem cor; diminuir faz o resumo apontar movimentos menores.",
  },
  change_strong: {
    rotulo: "Variação forte (%)",
    dica: "Contra o indicador, abaixo disto é atenção; a partir disto, perigo.",
    ajuda:
      "Vale para a mudança CONTRA o indicador: faturamento que cai, frete que sobe. Entre a variação estável e esta, o indicador fica em atenção (amarelo); a partir desta, em perigo (vermelho). Aumentar deixa menos coisa vermelha; diminuir faz o vermelho aparecer mais cedo. Precisa ser maior que a estável.",
  },
  points_neutral: {
    rotulo: "Variação estável em pontos (p.p.)",
    dica: "O mesmo para margem, ACOS e TACoS, que mudam em pontos percentuais.",
    ajuda:
      "Para os indicadores que já são porcentagens (margem, participação da comissão e do custo na receita, ACOS, TACoS e as margens após imposto e de contribuição), a mudança se mede em pontos percentuais: a margem de 12% para 11,6% mudou 0,4 p.p. Abaixo deste valor, fica sem cor. Aumentar silencia mudanças pequenas; diminuir colore mais.",
  },
  points_strong: {
    rotulo: "Variação forte em pontos (p.p.)",
    dica: "Contra o indicador, abaixo disto é atenção; a partir disto, perigo.",
    ajuda:
      "A variação forte, em pontos percentuais: contra o indicador, entre a estável em pontos e esta é atenção; a partir desta, perigo. Aumentar deixa menos coisa vermelha; diminuir faz o vermelho aparecer mais cedo. Precisa ser maior que a estável em pontos.",
  },
  goal_delay_warning: {
    rotulo: "Atraso da meta que ainda é atenção (%)",
    dica: "Abaixo do esperado até ontem por até isto é atenção; mais que isso, perigo.",
    ajuda:
      "Com o mês em andamento, a central compara o realizado até ontem com o esperado até ontem (a meta repartida pelos dias, com o peso de cada dia da semana). Um atraso de até este percentual do esperado deixa o ritmo em atenção; mais que isso, em perigo, e a meta entra em \"O que precisa da sua atenção\". Aumentar tolera atrasos maiores no amarelo; diminuir leva ao vermelho mais cedo.",
  },
  margin_floor: {
    rotulo: "Margem mínima dos produtos (%)",
    dica: "Produto com margem abaixo disto aparece em atenção e na lista \"Margem abaixo de\" do faturamento.",
    ajuda:
      "É o corte de margem dos produtos (o resultado da venda sobre a receita, nos pedidos com frete e custo conhecidos). Margem negativa é perigo; abaixo deste corte, atenção. Vale no tom da margem do ranking e do faturamento, na lista \"Margem abaixo de\" e na calculadora do faturamento, e no alerta de margem baixa da central. Aumentar põe mais produtos em atenção; diminuir, menos.",
  },
  ads_roas_floor: {
    rotulo: "ROAS abaixo da meta (% da meta da campanha)",
    dica: "Campanha com ROAS abaixo desta parte da meta que ela tem no Mercado Ads fica em \"ROAS abaixo da meta\".",
    ajuda:
      "ROAS é quanto a campanha vendeu para cada real investido em Ads, e cada campanha tem uma meta de ROAS no Mercado Ads. Com este valor em 80, uma campanha com meta de 5x fica em \"ROAS abaixo da meta\" quando o ROAS da semana fica abaixo de 4x (com pelo menos R$ 50 investidos e alguma venda), e o alerta é gravado na central. Aumentar sinaliza mais campanhas; diminuir, menos.",
  },
  margin_after_ads_low: {
    rotulo: "Margem depois do Ads baixa (%)",
    dica: "Campanha com espaço para escalar, mas margem estimada abaixo disto: a sugestão é revisar custos antes.",
    ajuda:
      "Só vale para campanhas em \"Oportunidade de escala\". A margem depois do Ads é a margem média da empresa na semana menos o ACOS da campanha (o investimento sobre as vendas que ela trouxe). Abaixo deste valor, a sugestão deixa de ser aumentar o orçamento e passa a ser revisar custos, preço, frete e comissão. Muda só a sugestão, não o nível nem a contagem. Aceita zero.",
  },
  min_orders_sample: {
    rotulo: "Amostra mínima (pedidos)",
    dica: "Margem, frete e médias só se comparam com pelo menos estes pedidos cobertos nos dois períodos.",
    ajuda:
      "Pedido coberto é o que tem frete e custo conhecidos e um produto só. A margem, o frete médio e outras médias só se comparam com o período anterior quando os dois períodos têm pelo menos este número de pedidos cobertos; abaixo disso, o indicador aparece sem comparação e diz por quê. Aumentar esconde mais comparações em períodos curtos; diminuir aceita comparações com mais ruído. O ranking e o detector de frete têm mínimos próprios.",
  },
};

/**
 * Os limites agrupados pelo que controlam (UX_SYSTEM §6, bloco 2): nove campos
 * numa grade só não diziam qual mexe em quê. A ordem dos campos dentro dos
 * grupos é a de `CAMPOS_DOS_LIMITES`.
 */
export const GRUPOS_DOS_LIMITES: readonly {
  readonly id: string;
  readonly titulo: string;
  readonly descricao: string;
  readonly campos: readonly CampoDosLimites[];
}[] = [
  {
    id: "comparacao",
    titulo: "Comparação com o período anterior",
    descricao: "Dão a cor (estável, atenção ou perigo) dos indicadores e as frases do resumo na central.",
    campos: ["change_neutral", "change_strong", "points_neutral", "points_strong", "min_orders_sample"],
  },
  {
    id: "meta",
    titulo: "Meta do mês",
    descricao: "O ritmo da meta na central e o alerta de meta atrasada.",
    campos: ["goal_delay_warning"],
  },
  {
    id: "produtos",
    titulo: "Produtos",
    descricao: "O corte de margem do ranking, do faturamento e dos alertas.",
    campos: ["margin_floor"],
  },
  {
    id: "ads",
    titulo: "Mercado Ads",
    descricao: "Os sinais de cada campanha em Sinais de Ads.",
    campos: ["ads_roas_floor", "margin_after_ads_low"],
  },
];

/** Rótulo, dica com o padrão e o valor atual de cada limite, na ordem da tela. */
export function descreverLimites(
  l: LimitesDaCentral,
): readonly {
  readonly campo: CampoDosLimites;
  readonly rotulo: string;
  readonly dica: string;
  readonly ajuda: string;
  readonly atual: string;
}[] {
  const atuais = valoresDosLimites(l);
  const padroes = valoresDosLimites(LIMITES_PADRAO);

  return CAMPOS_DOS_LIMITES.map((campo) => ({
    campo,
    rotulo: TEXTOS[campo].rotulo,
    dica: `${TEXTOS[campo].dica} Padrão: ${comoDigitado(campo, padroes[campo])}.`,
    ajuda: TEXTOS[campo].ajuda,
    atual: comoDigitado(campo, atuais[campo]),
  }));
}

/**
 * "2" ou "2%" → 0.02; até duas casas na porcentagem (0,25 p.p. → 0.0025). A
 * mensagem fala na unidade do campo: os de pontos dizem "p.p.", não "%"
 * (UX_SYSTEM §6, bloco 2). As regras não mudam.
 */
function lerPorcentagem(texto: string, rotulo: string, max: number, aceitaZero: boolean, unidade: "%" | "p.p."): Leitura<number> {
  const n = numeroDigitado(texto);
  const Rotulo = `${rotulo.charAt(0).toUpperCase()}${rotulo.slice(1)}`;
  const u = unidade === "%" ? "%" : " p.p.";
  // "p.p." já termina em ponto: a frase não ganha outro.
  const fim = unidade === "%" ? "%." : " p.p.";

  if (n === null) {
    return {
      ok: false,
      erro:
        unidade === "%"
          ? `Escreva ${rotulo} em porcentagem, por exemplo 2 ou 0,5.`
          : `Escreva ${rotulo} em pontos percentuais, por exemplo 0,5 ou 2.`,
    };
  }
  if (n > max || (n === 0 && !aceitaZero)) {
    return {
      ok: false,
      erro: aceitaZero
        ? `${Rotulo} fica entre 0${u} e ${PORCENTAGEM.format(max)}${fim}`
        : `${Rotulo} fica acima de 0${u} e até ${PORCENTAGEM.format(max)}${fim}`,
    };
  }

  const fracao = Math.round(n * 100) / 10000;

  if (Math.abs(fracao * 100 - n) > 1e-9) return { ok: false, erro: "Use no máximo duas casas decimais." };

  return { ok: true, valor: fracao };
}

/**
 * O formulário → os valores do banco, com as mesmas regras dos CHECKs para o
 * erro sair ao lado do campo, e não como "o banco recusou".
 */
export function lerFormularioDosLimites(
  campo: (nome: CampoDosLimites) => string,
): { readonly ok: true; readonly valores: ValoresDosLimites } | { readonly ok: false; readonly erros: Partial<Record<CampoDosLimites, string>> } {
  const erros: Partial<Record<CampoDosLimites, string>> = {};
  const lidos: Partial<Record<CampoDosLimites, number>> = {};

  // [rótulo, máximo, aceita zero, unidade] -- os mesmos limites dos CHECKs da tabela.
  const regras: Record<
    Exclude<CampoDosLimites, "min_orders_sample">,
    readonly [string, number, boolean, "%" | "p.p."]
  > = {
    change_neutral: ["a variação estável", 100, false, "%"],
    change_strong: ["a variação forte", 100, false, "%"],
    points_neutral: ["a variação estável em pontos", 20, false, "p.p."],
    points_strong: ["a variação forte em pontos", 20, false, "p.p."],
    goal_delay_warning: ["o atraso da meta", 99.99, false, "%"],
    margin_floor: ["a margem mínima", 99.99, false, "%"],
    margin_after_ads_low: ["a margem depois do Ads", 99.99, true, "%"],
    ads_roas_floor: ["o piso do ROAS", 100, false, "%"],
  };

  for (const [nome, [rotulo, max, aceitaZero, unidade]] of Object.entries(regras) as [
    keyof typeof regras,
    readonly [string, number, boolean, "%" | "p.p."],
  ][]) {
    const lido = lerPorcentagem(campo(nome), rotulo, max, aceitaZero, unidade);

    if (lido.ok) lidos[nome] = lido.valor;
    else erros[nome] = lido.erro;
  }

  const amostra = numeroDigitado(campo("min_orders_sample"));

  if (amostra === null || !Number.isInteger(amostra) || amostra < 1 || amostra > 1000) {
    erros.min_orders_sample = "A amostra mínima é um número inteiro de pedidos, de 1 a 1.000.";
  } else {
    lidos.min_orders_sample = amostra;
  }

  if (lidos.change_neutral !== undefined && lidos.change_strong !== undefined && lidos.change_neutral >= lidos.change_strong) {
    erros.change_strong = "A variação forte precisa ser maior que a estável.";
  }

  if (lidos.points_neutral !== undefined && lidos.points_strong !== undefined && lidos.points_neutral >= lidos.points_strong) {
    erros.points_strong = "A variação forte em pontos precisa ser maior que a estável.";
  }

  if (Object.keys(erros).length > 0) return { ok: false, erros };

  return { ok: true, valores: lidos as ValoresDosLimites };
}
