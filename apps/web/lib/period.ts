/**
 * O VOCABULÁRIO DE PERÍODO DO APP, num lugar só (D-311).
 *
 * Os cinco presets nasceram em `/vendas`, foram copiados para `/anuncios` em
 * D-308 — com a regra escrita lá: *"'últimos 30 dias' precisa querer dizer a
 * mesma coisa nas duas telas, senão o mesmo anúncio conta uma venda aqui e
 * outra lá"* — e a terceira tela a querer um seletor foi a Home. Duas cópias
 * são coincidência; três é uma divergência esperando acontecer, e esta casa já
 * pagou essa conta cinco vezes com mapas de tom (D-246).
 *
 * Então o trio muda de casa: saiu de `lib/listings-dashboard.ts`, que é
 * batizado por UMA tela, e `/vendas` apagou a própria cópia da lista.
 *
 * **O tipo é a guarda.** `PeriodPreset` é a união dos cinco literais, e
 * `resolvePeriodDays` só aceita um deles como padrão — então "14 dias", o
 * número que o frame da Home desenha no botão, **não compila**. A terceira
 * lista de períodos deixou de ser algo proibido por comentário para ser algo
 * que o compilador recusa.
 *
 * A janela mexe no DESEMPENHO, nunca no conjunto: é a lição de D-308, e vale
 * para qualquer tela que adote este vocabulário.
 */
export const PERIOD_PRESETS = [7, 15, 30, 60, 90] as const;

export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

/** O que `/vendas` e `/anuncios` sempre mostraram antes de haver seletor. Fica fora da URL. */
export const DEFAULT_PERIOD_DAYS: PeriodPreset = 30;

/**
 * O padrão do gráfico da Home.
 *
 * **O frame diz "14 dias" e aqui são 15**, de propósito: 14 não está na lista
 * fechada e 15 está. A leitura da Home muda em UM dia — nenhum número de
 * negócio depende disso — e em troca o app inteiro passa a ter uma lista só. O
 * botão do frame, aliás, não oferece opção nenhuma: é um `<button>` sem estado
 * no protótipo, então o "14" literal não defende nada.
 */
export const HOME_SERIE_DEFAULT_DAYS: PeriodPreset = 15;

const PERIOD_VALUES = new Set<number>(PERIOD_PRESETS);

/**
 * Lista fechada pelo mesmo motivo das outras listas de filtro: um valor
 * arbitrário viajaria até `p_date_from` e devolveria uma janela que ninguém
 * pediu — ou, com número enorme, uma varredura cara que a tela não anuncia.
 *
 * `fallback` é tipado como `PeriodPreset` para que o padrão de cada tela seja
 * obrigatoriamente uma das cinco opções que o menu oferece: um padrão fora do
 * menu deixaria o botão sem opção ativa, mostrando um rótulo que a lista não
 * contém.
 */
export function resolvePeriodDays(raw: unknown, fallback: PeriodPreset = DEFAULT_PERIOD_DAYS): number {
  const dias = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;

  return PERIOD_VALUES.has(dias) ? dias : fallback;
}
