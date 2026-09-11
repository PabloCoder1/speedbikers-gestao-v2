import { classifySalesTrend, computeUsableCoverageDays, computeUsableStock } from "@sb/domain";

/**
 * A COBERTURA DE UM SKU, EM TEXTO — uma conta, duas superfícies (D-314).
 *
 * O cartão "Cobertura" do Dashboard do SKU e a linha "Cobertura" da gaveta
 * Inspeção Rápida imprimiam `days_of_coverage` de `get_stock_coverage`, que é
 * **`local ÷ venda média`** — a definição que **D-288 aposentou** ao fundir
 * `/cobertura` com `/reposicao`. Aquela fatia corrigiu a PALAVRA em três
 * lugares ("ruptura" virou "sem saldo local"); faltou a CONTA em dois. Medido
 * no seed: **300 dias** no cartão contra **318** que `/reposicao` mostra para o
 * MESMO SKU — e o botão do cabeçalho desta tela leva justamente para lá.
 *
 * As duas telas passam a ler daqui, então elas não CONSEGUEM imprimir textos
 * diferentes. O número sai de `computeUsableCoverageDays`, a peça canônica
 * (METRICS §5D.4), a mesma que `/reposicao` e o Copiloto usam.
 *
 * **Nenhuma das saídas é veredito.** "Abaixo do lead time" — o que o frame
 * desenha em tom de perigo — exige política, e 86% do catálogo não tem
 * nenhuma; o estado operacional tem nome, régua e dono (`classifyStockState`,
 * em `/reposicao`). Aqui é aritmética, e a ressalva diz de onde ela vem.
 */
export interface EntradaDeCobertura {
  /** As quatro parcelas, como `get_sku_dashboard` e `get_purchase_suggestions` as devolvem. */
  readonly local: number;
  readonly full: number;
  readonly transito: number;
  readonly reservado: number;
  /** Saldo do ERP é sentinela, não contagem (D-127): sem número, com motivo. */
  readonly stockIsVirtual: boolean;
  readonly units15: number;
  readonly units30: number;
  readonly units60: number;
  readonly units90: number;
  readonly historyDays90: number;
}

export interface CoberturaDescrita {
  /** `null` quando a cobertura é indefinida — nunca "infinita" fingida (D-080). */
  readonly dias: number | null;
  /** O que vai no lugar do número. */
  readonly valor: string;
  /** A ressalva VISÍVEL ao lado do número, como METRICS 5C.2 exige. */
  readonly ressalva: string;
  /** A decomposição, no `title` — "por que aproveitável = 53?" começa aqui. */
  readonly titulo: string;
}

/*
  UMA casa decimal, que é a precisão que `simulateCoverageDays` produz (ela
  arredonda em 0,1) e a que o frame desenha ("4,2 dias"). Duas casas
  imprimiriam um zero que a conta não tem.
*/
const DIAS = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** A taxa é pequena por natureza (0,17/dia): duas casas, como em `/reposicao`. */
const TAXA = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const SEM_LINHA: CoberturaDescrita = {
  dias: null,
  valor: "—",
  ressalva: "não calculada para este SKU",
  titulo: "o cálculo de cobertura não devolveu linha para este SKU",
};

export function descreverCobertura(entrada: EntradaDeCobertura | null): CoberturaDescrita {
  if (entrada === null) return SEM_LINHA;

  const usable = computeUsableStock({
    localQuantity: entrada.local,
    fullQuantity: entrada.full,
    transitQuantity: entrada.transito,
    reservedQuantity: entrada.reservado,
    stockIsVirtual: entrada.stockIsVirtual,
  });

  const trend = classifySalesTrend({
    units15: entrada.units15,
    units30: entrada.units30,
    units60: entrada.units60,
    units90: entrada.units90,
    historyDays90: entrada.historyDays90,
  });

  const partes = `local ${String(usable.components.local)} + Full ${String(usable.components.full)} + trânsito ${String(usable.components.transit)}; reservado ${String(usable.components.reservedExcluded)} fica fora — a mesma conta de Cobertura e reposição`;

  if (usable.total === null) {
    return {
      dias: null,
      valor: "—",
      ressalva: "em branco de propósito: o saldo do ERP é sentinela, não contagem (D-127)",
      titulo: "SKU com estoque virtual: sem saldo confiável não há cobertura a calcular",
    };
  }

  if (trend.rateRecent <= 0) {
    return {
      dias: null,
      valor: "—",
      ressalva: "sem venda nos últimos 30 dias — não há taxa para dividir",
      titulo: partes,
    };
  }

  const dias = computeUsableCoverageDays(usable, trend);

  /*
    `dias` é número aqui — há saldo confiável e taxa positiva —, mas o
    compilador não sabe disso, e um `!` esconderia justamente o caso em que a
    peça canônica mudar de contrato.
  */
  if (dias === null) return SEM_LINHA;

  const aproveitavel = Math.max(usable.total, 0);

  return {
    dias,
    valor: `${DIAS.format(dias)} dias`,
    /*
      A ressalva carrega a CONTA, não um adjetivo: quem vê "318 dias" precisa
      saber que o divisor é a taxa de 30 dias e que o dividendo inclui Full e
      trânsito. É a diferença entre o número desta tela e o que ela mostrava
      antes — e é por ela que alguém percebe se as duas telas divergirem de
      novo.
    */
    ressalva: `aproveitável ${String(aproveitavel)} ÷ ${TAXA.format(trend.rateRecent)}/dia`,
    titulo: partes,
  };
}
