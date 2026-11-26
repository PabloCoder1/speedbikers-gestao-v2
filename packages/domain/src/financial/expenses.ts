/**
 * Regras puras de Gestão de Custos Fixos e Variáveis, Rateio e Orçamento vs. Realizado.
 *
 * - Suporta despesas fixas e variáveis, recorrentes, pontuais e sazonais.
 * - Gera chave de idempotência determinística para impedir duplicidade de lançamentos recorrentes.
 * - Distribui despesas compartilhadas por faturamento, volume de vendas, percentual fixo ou manual,
 *   garantindo que a soma dos rateios feche exatamente no valor total (ajuste de centavo na maior cota).
 * - Separa explicitamente despesas diretas de despesas rateadas.
 */

export type ClassificacaoCusto = "fixo" | "variavel";

export type RecorrenciaDespesa = "pontual" | "mensal" | "trimestral" | "anual" | "sazonal";

export type StatusDespesa = "prevista" | "paga" | "atrasada" | "cancelada";

export type MetodoRateio = "direto" | "faturamento" | "volume_vendas" | "percentual_fixo" | "manual";

export const CATEGORIAS_DESPESA = [
  "energia_eletrica",
  "agua",
  "internet",
  "aluguel",
  "condominio",
  "salarios",
  "encargos_trabalhistas",
  "beneficios",
  "pro_labore",
  "contabilidade",
  "softwares_assinaturas",
  "sistemas_gestao",
  "infraestrutura_nuvem",
  "banco_dados",
  "embalagens",
  "materiais_escritorio",
  "manutencao",
  "equipamentos",
  "seguros",
  "servicos_terceirizados",
  "despesas_bancarias",
  "despesas_administrativas",
  "despesas_extraordinarias",
  "logistica_full_armazenagem",
  "outras",
] as const;

export type CategoriaDespesa = (typeof CATEGORIAS_DESPESA)[number];

export const ROTULO_CATEGORIA_DESPESA: Readonly<Record<CategoriaDespesa, string>> = {
  energia_eletrica: "Energia elétrica",
  agua: "Água",
  internet: "Internet",
  aluguel: "Aluguel",
  condominio: "Condomínio",
  salarios: "Salários",
  encargos_trabalhistas: "Encargos trabalhistas",
  beneficios: "Benefícios",
  pro_labore: "Pró-labore",
  contabilidade: "Contabilidade",
  softwares_assinaturas: "Softwares e assinaturas",
  sistemas_gestao: "Sistemas de gestão",
  infraestrutura_nuvem: "Infraestrutura em nuvem",
  banco_dados: "Banco de dados",
  embalagens: "Embalagens",
  materiais_escritorio: "Materiais de escritório",
  manutencao: "Manutenção",
  equipamentos: "Equipamentos",
  seguros: "Seguros",
  servicos_terceirizados: "Serviços terceirizados",
  despesas_bancarias: "Despesas bancárias",
  despesas_administrativas: "Despesas administrativas",
  despesas_extraordinarias: "Despesas extraordinárias",
  logistica_full_armazenagem: "Envio ao Full / Armazenagem",
  outras: "Outras despesas",
};

export interface DestinoRateio {
  readonly destinoId: string;
  readonly rotulo: string;
  /** Peso usado quando o método é `faturamento`, `volume_vendas` ou `percentual_fixo`. */
  readonly peso: number;
  /** Valor em reais quando o método é `manual`. */
  readonly valorManual?: number;
}

export interface ParcelaRateio {
  readonly destinoId: string;
  readonly rotulo: string;
  readonly percentual: number;
  readonly valor: number;
  readonly origem: "direto" | "rateado";
}

export type ResultadoRateio =
  | { readonly ok: true; readonly parcelas: readonly ParcelaRateio[]; readonly total: number }
  | { readonly ok: false; readonly erro: string };

export interface ResumoOrcadoRealizado {
  readonly totalPrevisto: number;
  readonly totalRealizado: number;
  /** Realizado − previsto (positivo = estouro de orçamento; negativo = economia). */
  readonly desvioReais: number;
  /** Desvio percentual sobre o previsto (`null` se previsto === 0). */
  readonly desvioPercentual: number | null;
  readonly fixasPrevistas: number;
  readonly fixasRealizadas: number;
  readonly variaveisPrevistas: number;
  readonly variaveisRealizadas: number;
  readonly totalDiretas: number;
  readonly totalRateadas: number;
}

export interface DespesaResumoEntrada {
  readonly classificacao: ClassificacaoCusto;
  readonly status: StatusDespesa;
  readonly valorPrevisto: number;
  readonly valorRealizado: number | null;
  readonly metodoRateio: MetodoRateio;
}

function centavos(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Gera chave de idempotência determinística para impedir duplicidade de despesas
 * recorrentes na mesma competência (YYYY-MM).
 */
export function chaveIdempotenciaDespesa(params: {
  readonly organizationId: string;
  readonly origemRecorrenciaId: string;
  readonly competenciaYm: string;
}): string {
  return `exp:${params.organizationId}:${params.origemRecorrenciaId}:${params.competenciaYm}`;
}

/**
 * Calcula o rateio de uma despesa compartilhada entre contas, marketplaces ou empresas.
 *
 * Garante conservação exata de centavos: `sum(parcelas.valor) === centavos(valorTotal)`.
 */
export function ratearDespesa(
  valorTotal: number,
  metodo: MetodoRateio,
  destinos: readonly DestinoRateio[],
): ResultadoRateio {
  if (!Number.isFinite(valorTotal) || valorTotal < 0) {
    return { ok: false, erro: "O valor da despesa deve ser maior ou igual a zero." };
  }

  const total = centavos(valorTotal);

  if (destinos.length === 0) {
    return { ok: false, erro: "Informe ao menos um destino para a despesa." };
  }

  if (metodo === "direto") {
    if (destinos.length !== 1) {
      return { ok: false, erro: "Despesa direta deve estar vinculada a exatamente um destino." };
    }
    const unico = destinos[0];
    if (unico === undefined) return { ok: false, erro: "Destino ausente." };
    return {
      ok: true,
      total,
      parcelas: [{ destinoId: unico.destinoId, rotulo: unico.rotulo, percentual: 1, valor: total, origem: "direto" }],
    };
  }

  if (metodo === "manual") {
    const somaManual = centavos(destinos.reduce((acc, d) => acc + (d.valorManual ?? 0), 0));
    if (destinos.some((d) => d.valorManual === undefined || !Number.isFinite(d.valorManual) || d.valorManual < 0)) {
      return { ok: false, erro: "Todos os destinos manuais precisam de um valor válido >= 0." };
    }
    if (Math.abs(somaManual - total) > 0.01) {
      return {
        ok: false,
        erro: `A soma do rateio manual (R$ ${somaManual.toFixed(2)}) precisa fechar com o valor total (R$ ${total.toFixed(2)}).`,
      };
    }

    return {
      ok: true,
      total,
      parcelas: destinos.map((d) => {
        const valor = centavos(d.valorManual ?? 0);
        return {
          destinoId: d.destinoId,
          rotulo: d.rotulo,
          percentual: total > 0 ? valor / total : 0,
          valor,
          origem: "rateado",
        };
      }),
    };
  }

  if (destinos.some((d) => !Number.isFinite(d.peso) || d.peso < 0)) {
    return { ok: false, erro: "Os pesos de rateio não podem ser negativos." };
  }

  const somaPesos = destinos.reduce((acc, d) => acc + d.peso, 0);

  if (somaPesos <= 0) {
    return { ok: false, erro: "A base de rateio selecionada está zerada no período." };
  }

  if (metodo === "percentual_fixo" && Math.abs(somaPesos - 100) > 0.01 && Math.abs(somaPesos - 1) > 0.0001) {
    return { ok: false, erro: "No rateio por percentual fixo, a soma dos percentuais deve fechar em 100%." };
  }

  const brutas = destinos.map((d) => {
    const percentual = d.peso / somaPesos;
    return {
      destinoId: d.destinoId,
      rotulo: d.rotulo,
      percentual,
      valor: centavos(total * percentual),
      origem: "rateado" as const,
    };
  });

  // Ajusta eventual diferença de arredondamento (1-2 centavos) no destino de maior peso.
  const somaArredondada = centavos(brutas.reduce((acc, p) => acc + p.valor, 0));
  const diff = centavos(total - somaArredondada);

  if (diff !== 0 && brutas.length > 0) {
    let idxMaior = 0;
    for (let i = 1; i < brutas.length; i += 1) {
      if ((brutas[i]?.percentual ?? 0) > (brutas[idxMaior]?.percentual ?? 0)) {
        idxMaior = i;
      }
    }
    const alvo = brutas[idxMaior];
    if (alvo !== undefined) {
      brutas[idxMaior] = { ...alvo, valor: centavos(alvo.valor + diff) };
    }
  }

  return { ok: true, total, parcelas: brutas };
}

/**
 * Consolida Orçamento (Previsto) vs. Realizado, separando fixas, variáveis,
 * diretas e rateadas. Despesas canceladas são ignoradas.
 */
export function resumirOrcadoRealizado(despesas: readonly DespesaResumoEntrada[]): ResumoOrcadoRealizado {
  let fixasPrevistas = 0;
  let fixasRealizadas = 0;
  let variaveisPrevistas = 0;
  let variaveisRealizadas = 0;
  let totalDiretas = 0;
  let totalRateadas = 0;

  for (const d of despesas) {
    if (d.status === "cancelada") continue;

    const previsto = Number.isFinite(d.valorPrevisto) ? Math.max(0, d.valorPrevisto) : 0;
    // Valor realizado efetivo: quando pago/lançado usa valorRealizado; se ainda prevista, conta 0 no realizado.
    const realizado =
      d.valorRealizado !== null && Number.isFinite(d.valorRealizado)
        ? Math.max(0, d.valorRealizado)
        : 0;

    if (d.classificacao === "fixo") {
      fixasPrevistas += previsto;
      fixasRealizadas += realizado;
    } else {
      variaveisPrevistas += previsto;
      variaveisRealizadas += realizado;
    }

    const baseOrigem = realizado > 0 ? realizado : previsto;
    if (d.metodoRateio === "direto") {
      totalDiretas += baseOrigem;
    } else {
      totalRateadas += baseOrigem;
    }
  }

  fixasPrevistas = centavos(fixasPrevistas);
  fixasRealizadas = centavos(fixasRealizadas);
  variaveisPrevistas = centavos(variaveisPrevistas);
  variaveisRealizadas = centavos(variaveisRealizadas);

  const totalPrevisto = centavos(fixasPrevistas + variaveisPrevistas);
  const totalRealizado = centavos(fixasRealizadas + variaveisRealizadas);
  const desvioReais = centavos(totalRealizado - totalPrevisto);
  const desvioPercentual = totalPrevisto > 0 ? desvioReais / totalPrevisto : null;

  return {
    totalPrevisto,
    totalRealizado,
    desvioReais,
    desvioPercentual,
    fixasPrevistas,
    fixasRealizadas,
    variaveisPrevistas,
    variaveisRealizadas,
    totalDiretas: centavos(totalDiretas),
    totalRateadas: centavos(totalRateadas),
  };
}
