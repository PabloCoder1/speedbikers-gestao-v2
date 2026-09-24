import type { Tom } from "../components/tone";

/**
 * Variação entre dois períodos e o TOM dela (D-394, `docs/METRICS.md` 5I).
 *
 * Os dois números chegam prontos do SQL; aqui só se compara um com o outro — a
 * mesma natureza de `participacao` em `lib/faturamento.ts`. Nada é somado.
 *
 * **Subir nem sempre é bom.** Cada indicador declara a sua polaridade: receita
 * que sobe é boa, frete que sobe é ruim, investimento em Ads que sobe não é bom
 * nem ruim por si (quem julga é o ROAS e o TACoS). O tom sai da polaridade e do
 * tamanho do movimento, nunca só do sinal.
 */

export type Polaridade = "maior-melhor" | "menor-melhor" | "neutra";

/**
 * `valor` compara pela variação relativa (`variacao_percentual_periodo`);
 * `fracao` compara pela diferença em pontos percentuais
 * (`variacao_pontos_percentuais`) — margem de 20% para 18% é −2 p.p., e dizer
 * "−10%" sobre uma porcentagem confunde quem lê.
 */
export type Escala = "valor" | "fracao";

export type LimitesDaVariacao = Readonly<Record<Escala, { readonly neutro: number; readonly forte: number }>>;

/**
 * Os cortes do tom: abaixo de `neutro` o movimento é ruído; contra a
 * polaridade, até `forte` é atenção e a partir dele é perigo. Estes são os
 * PADRÕES; a organização muda os seus em `/central/limites` (D-148, D-408).
 */
export const LIMITES_DA_VARIACAO: LimitesDaVariacao = {
  valor: { neutro: 0.02, forte: 0.1 },
  fracao: { neutro: 0.005, forte: 0.02 },
};

export interface Variacao {
  readonly anterior: number;
  /** `atual − anterior`, na unidade do indicador (reais, contagem ou fração). */
  readonly diferenca: number;
  /**
   * `(atual − anterior) ÷ anterior`, só para `valor` e só com anterior
   * POSITIVO. Anterior zero não tem variação percentual (seria infinita), e
   * anterior negativo inverte o sentido da conta — os dois ficam `null` e a
   * tela mostra só a diferença.
   */
  readonly relativa: number | null;
  readonly direcao: "sobe" | "desce" | "igual";
  /** O movimento passou da zona neutra. */
  readonly relevante: boolean;
  readonly tom: Tom;
}

export interface OpcoesDaVariacao {
  /**
   * Força o tom neutro mantendo os números: o volume de um período com hoje
   * dentro ainda cresce, e julgá-lo contra dias inteiros pintaria de vermelho
   * um dia que só não acabou.
   */
  readonly semJulgamento?: boolean;
  /** Os cortes da organização (D-408); sem eles, os padrões. */
  readonly limites?: LimitesDaVariacao;
}

/** `null` quando falta um dos lados — sem os dois não existe comparação, e isso não é zero. */
export function avaliarVariacao(
  atual: number | null,
  anterior: number | null,
  polaridade: Polaridade,
  escala: Escala,
  opcoes: OpcoesDaVariacao = {},
): Variacao | null {
  if (atual === null || anterior === null) return null;

  const diferenca = atual - anterior;
  const relativa = escala === "valor" && anterior > 0 ? diferenca / anterior : null;
  const direcao = diferenca > 0 ? "sobe" : diferenca < 0 ? "desce" : "igual";

  // A grandeza que decide o tom: relativa para valor, pontos para fração. Um
  // valor sem relativa (anterior zero ou negativo) não tem como ser julgado.
  const grandeza = escala === "fracao" ? Math.abs(diferenca) : relativa === null ? null : Math.abs(relativa);
  const limites = (opcoes.limites ?? LIMITES_DA_VARIACAO)[escala];
  const relevante = grandeza !== null && grandeza >= limites.neutro;

  let tom: Tom = "neutro";

  if (grandeza !== null && relevante && polaridade !== "neutra" && opcoes.semJulgamento !== true) {
    const favoravel = polaridade === "maior-melhor" ? diferenca > 0 : diferenca < 0;

    if (favoravel) tom = "ok";
    else tom = grandeza >= limites.forte ? "perigo" : "atencao";
  }

  return { anterior, diferenca, relativa, direcao, relevante, tom };
}

const SETA: Readonly<Record<Variacao["direcao"], string>> = { sobe: "↑", desce: "↓", igual: "=" };

const PONTOS = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const PORCENTO = new Intl.NumberFormat("pt-BR", {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/**
 * O texto curto da variação: "↑ 12,8%", "↓ 2,1 p.p." ou "↑" sozinho quando o
 * anterior era zero (subiu, mas não há porcentagem honesta para isso).
 */
export function textoDaVariacao(variacao: Variacao, escala: Escala): string {
  const seta = SETA[variacao.direcao];

  if (escala === "fracao") return `${seta} ${PONTOS.format(Math.abs(variacao.diferenca) * 100)} p.p.`;
  if (variacao.relativa === null) return seta;

  return `${seta} ${PORCENTO.format(Math.abs(variacao.relativa))}`;
}
