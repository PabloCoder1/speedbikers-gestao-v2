import {
  CATEGORIAS_DESPESA,
  selecionarConfigTributariaVigente,
  type CategoriaDespesa,
  type ClassificacaoCusto,
  type ConfiguracaoTributaria,
  type MetodoRateio,
  type RecorrenciaDespesa,
  type RegimeTributario,
  type StatusDespesa,
} from "@sb/domain";

import { lerData, lerNota, lerPercentual, numeroDigitado, type Leitura } from "./metas-imposto";

/**
 * Validação pura dos formulários de Custos Operacionais e Entidades Fiscais
 * (`/central/custos`), sem React e sem banco — 100% testável.
 */

export const RECORRENCIAS_DESPESA: readonly { readonly id: RecorrenciaDespesa; readonly rotulo: string }[] = [
  { id: "mensal", rotulo: "Mensal" },
  { id: "pontual", rotulo: "Pontual" },
  { id: "trimestral", rotulo: "Trimestral" },
  { id: "anual", rotulo: "Anual" },
  { id: "sazonal", rotulo: "Sazonal" },
];

export const METODOS_RATEIO: readonly { readonly id: MetodoRateio; readonly rotulo: string }[] = [
  { id: "faturamento", rotulo: "Rateado por faturamento" },
  { id: "volume_vendas", rotulo: "Rateado por volume de vendas" },
  { id: "percentual_fixo", rotulo: "Rateado por percentual fixo" },
  { id: "manual", rotulo: "Rateio manual" },
  { id: "direto", rotulo: "Direto (conta/marketplace específico)" },
];

export const STATUS_DESPESA: readonly { readonly id: StatusDespesa; readonly rotulo: string }[] = [
  { id: "prevista", rotulo: "Prevista" },
  { id: "paga", rotulo: "Paga" },
  { id: "atrasada", rotulo: "Atrasada" },
  { id: "cancelada", rotulo: "Cancelada" },
];

export const REGIMES_TRIBUTARIOS: readonly RegimeTributario[] = [
  "simples_nacional",
  "lucro_presumido",
  "lucro_real",
  "configuravel",
];

/** Formata CNPJ (14 dígitos) no padrão 00.000.000/0000-00. */
export function formatarCnpj(cnpj: string): string {
  const d = cnpj.replace(/\D/g, "");
  if (d.length !== 14) return cnpj;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

/** Normaliza e valida um CNPJ brasileiro (14 dígitos + dígitos verificadores). */
export function lerCnpj(texto: string): Leitura<string> {
  const digitos = texto.replace(/\D/g, "");

  if (digitos.length !== 14) {
    return { ok: false, erro: "Informe um CNPJ válido com 14 dígitos." };
  }

  if (/^(\d)\1{13}$/.test(digitos)) {
    return { ok: false, erro: "CNPJ inválido (todos os dígitos iguais)." };
  }

  const calc = (base: string, pesos: readonly number[]): number => {
    let soma = 0;
    for (let i = 0; i < pesos.length; i += 1) {
      soma += Number(base[i]) * (pesos[i] ?? 0);
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };

  const d1 = calc(digitos.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = calc(digitos.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);

  if (d1 !== Number(digitos[12]) || d2 !== Number(digitos[13])) {
    return { ok: false, erro: "Dígitos verificadores do CNPJ não conferem." };
  }

  return { ok: true, valor: digitos };
}

export function lerValorMonetarioOpcional(texto: string, rotulo: string): Leitura<number | null> {
  const limpo = texto.trim();
  if (limpo === "") return { ok: true, valor: null };

  const n = numeroDigitado(limpo);
  if (n === null || n < 0 || n >= 1e12) {
    return { ok: false, erro: `Informe um valor válido em reais para ${rotulo} (ex.: 1.250,00).` };
  }

  return { ok: true, valor: Math.round(n * 100) / 100 };
}

export function lerValorMonetarioObrigatorio(texto: string, rotulo: string): Leitura<number> {
  const lido = lerValorMonetarioOpcional(texto, rotulo);
  if (!lido.ok) return lido;
  if (lido.valor === null) return { ok: false, erro: `Informe ${rotulo} em reais.` };
  return { ok: true, valor: lido.valor };
}

export interface DespesaValidada {
  readonly name: string;
  readonly category: CategoriaDespesa;
  readonly cost_type: ClassificacaoCusto;
  readonly recurrence: RecorrenciaDespesa;
  readonly allocation_method: MetodoRateio;
  readonly planned_amount: number;
  readonly actual_amount: number | null;
  readonly competence_date: string;
  readonly due_date: string | null;
  readonly paid_date: string | null;
  readonly status: StatusDespesa;
  readonly marketplace: "MERCADO_LIVRE" | "SHOPEE" | "TODOS";
  readonly cost_center: string | null;
  readonly note: string | null;
}

export function lerFormularioDespesa(
  campo: (nome: string) => string,
): { readonly ok: true; readonly valor: DespesaValidada } | { readonly ok: false; readonly erros: Record<string, string> } {
  const erros: Record<string, string> = {};

  const name = campo("name").trim();
  if (name.length < 2 || name.length > 140) {
    erros.name = "Informe o nome da despesa (entre 2 e 140 caracteres).";
  }

  const rawCat = campo("category").trim();
  const category = (CATEGORIAS_DESPESA as readonly string[]).includes(rawCat) ? (rawCat as CategoriaDespesa) : null;
  if (category === null) erros.category = "Escolha uma categoria válida.";

  const rawTipo = campo("cost_type").trim();
  const costType = rawTipo === "fixo" || rawTipo === "variavel" ? rawTipo : null;
  if (costType === null) erros.cost_type = "Informe se o custo é fixo ou variável.";

  const rawRec = campo("recurrence").trim();
  const recurrence = RECORRENCIAS_DESPESA.some((r) => r.id === rawRec) ? (rawRec as RecorrenciaDespesa) : null;
  if (recurrence === null) erros.recurrence = "Escolha uma recorrência válida.";

  const rawRateio = campo("allocation_method").trim();
  const allocationMethod = METODOS_RATEIO.some((m) => m.id === rawRateio) ? (rawRateio as MetodoRateio) : null;
  if (allocationMethod === null) erros.allocation_method = "Escolha um critério de rateio válido.";

  const rawStatus = campo("status").trim();
  const status = STATUS_DESPESA.some((s) => s.id === rawStatus) ? (rawStatus as StatusDespesa) : null;
  if (status === null) erros.status = "Escolha um status válido.";

  const rawMkt = campo("marketplace").trim() || "TODOS";
  const marketplace =
    rawMkt === "MERCADO_LIVRE" || rawMkt === "SHOPEE" || rawMkt === "TODOS" ? rawMkt : "TODOS";

  const planned = lerValorMonetarioObrigatorio(campo("planned_amount"), "o valor previsto");
  if (!planned.ok) erros.planned_amount = planned.erro;

  const actual = lerValorMonetarioOpcional(campo("actual_amount"), "o valor realizado");
  if (!actual.ok) erros.actual_amount = actual.erro;

  const competence = lerData(campo("competence_date"));
  if (!competence.ok) erros.competence_date = "Escolha a data de competência.";

  const dueRaw = campo("due_date").trim();
  const due = dueRaw === "" ? ({ ok: true, valor: null } as const) : lerData(dueRaw);
  if (!due.ok) erros.due_date = "Data de vencimento inválida.";

  const paidRaw = campo("paid_date").trim();
  const paid = paidRaw === "" ? ({ ok: true, valor: null } as const) : lerData(paidRaw);
  if (!paid.ok) erros.paid_date = "Data de pagamento inválida.";

  const costCenterRaw = campo("cost_center").trim();
  if (costCenterRaw.length > 100) erros.cost_center = "Centro de custo deve ter até 100 caracteres.";

  const note = lerNota(campo("note"));
  if (!note.ok) erros.note = note.erro;

  if (
    Object.keys(erros).length > 0 ||
    category === null ||
    costType === null ||
    recurrence === null ||
    allocationMethod === null ||
    status === null ||
    !planned.ok ||
    !actual.ok ||
    !competence.ok ||
    !due.ok ||
    !paid.ok ||
    !note.ok
  ) {
    return { ok: false, erros };
  }

  return {
    ok: true,
    valor: {
      name,
      category,
      cost_type: costType,
      recurrence,
      allocation_method: allocationMethod,
      planned_amount: planned.valor,
      actual_amount: actual.valor,
      competence_date: competence.valor,
      due_date: due.valor,
      paid_date: paid.valor,
      status,
      marketplace,
      cost_center: costCenterRaw === "" ? null : costCenterRaw,
      note: note.valor,
    },
  };
}

export interface EntidadeFiscalValidada {
  readonly legal_name: string;
  readonly trade_name: string | null;
  readonly cnpj: string;
  readonly tax_regime: RegimeTributario;
  readonly note: string | null;
}

export function lerFormularioEntidadeFiscal(
  campo: (nome: string) => string,
): { readonly ok: true; readonly valor: EntidadeFiscalValidada } | { readonly ok: false; readonly erros: Record<string, string> } {
  const erros: Record<string, string> = {};

  const legalName = campo("legal_name").trim();
  if (legalName.length < 2 || legalName.length > 160) {
    erros.legal_name = "Informe a razão social (entre 2 e 160 caracteres).";
  }

  const tradeNameRaw = campo("trade_name").trim();
  if (tradeNameRaw.length > 160) {
    erros.trade_name = "Nome fantasia deve ter até 160 caracteres.";
  }

  const cnpj = lerCnpj(campo("cnpj"));
  if (!cnpj.ok) erros.cnpj = cnpj.erro;

  const rawRegime = campo("tax_regime").trim();
  const regime = (REGIMES_TRIBUTARIOS as readonly string[]).includes(rawRegime)
    ? (rawRegime as RegimeTributario)
    : null;
  if (regime === null) erros.tax_regime = "Escolha o regime tributário.";

  const note = lerNota(campo("note"));
  if (!note.ok) erros.note = note.erro;

  if (Object.keys(erros).length > 0 || !cnpj.ok || regime === null || !note.ok) {
    return { ok: false, erros };
  }

  return {
    ok: true,
    valor: {
      legal_name: legalName,
      trade_name: tradeNameRaw === "" ? null : tradeNameRaw,
      cnpj: cnpj.valor,
      tax_regime: regime,
      note: note.valor,
    },
  };
}

export interface VigenciaTributariaValidada {
  readonly fiscal_entity_id: string;
  readonly tax_regime: RegimeTributario;
  readonly valid_from: string;
  readonly nominal_rate: number;
  readonly effective_sales_rate: number;
  readonly tax_credits_rate: number;
  readonly profit_tax_rate: number;
  readonly validated_by_accountant: boolean;
  readonly source_note: string | null;
}

export function lerFormularioVigenciaTributaria(
  campo: (nome: string) => string,
): { readonly ok: true; readonly valor: VigenciaTributariaValidada } | { readonly ok: false; readonly erros: Record<string, string> } {
  const erros: Record<string, string> = {};

  const entityId = campo("fiscal_entity_id").trim();
  if (entityId === "") erros.fiscal_entity_id = "Selecione a empresa (CNPJ).";

  const rawRegime = campo("tax_regime").trim();
  const regime = (REGIMES_TRIBUTARIOS as readonly string[]).includes(rawRegime)
    ? (rawRegime as RegimeTributario)
    : null;
  if (regime === null) erros.tax_regime = "Escolha o regime tributário.";

  const validFrom = lerData(campo("valid_from"));
  if (!validFrom.ok) erros.valid_from = "Escolha a data de início da vigência.";

  const nominal = lerPercentual(campo("nominal_rate"));
  if (!nominal.ok) erros.nominal_rate = nominal.erro;

  const effective = lerPercentual(campo("effective_sales_rate"));
  if (!effective.ok) erros.effective_sales_rate = effective.erro;

  const creditsRaw = campo("tax_credits_rate").trim() || "0";
  const credits = lerPercentual(creditsRaw);
  if (!credits.ok) erros.tax_credits_rate = credits.erro;

  const profitRaw = campo("profit_tax_rate").trim() || "0";
  const profit = lerPercentual(profitRaw);
  if (!profit.ok) erros.profit_tax_rate = profit.erro;

  const note = lerNota(campo("source_note"));
  if (!note.ok) erros.source_note = note.erro;

  if (
    Object.keys(erros).length > 0 ||
    entityId === "" ||
    regime === null ||
    !validFrom.ok ||
    !nominal.ok ||
    !effective.ok ||
    !credits.ok ||
    !profit.ok ||
    !note.ok
  ) {
    return { ok: false, erros };
  }

  return {
    ok: true,
    valor: {
      fiscal_entity_id: entityId,
      tax_regime: regime,
      valid_from: validFrom.valor,
      nominal_rate: nominal.valor,
      effective_sales_rate: effective.valor,
      tax_credits_rate: credits.valor,
      profit_tax_rate: profit.valor,
      validated_by_accountant: campo("validated_by_accountant") === "on" || campo("validated_by_accountant") === "true",
      source_note: note.valor,
    },
  };
}

export interface ResumoDespesasPeriodo {
  readonly despesasFixas: number | null;
  readonly despesasVariaveis: number | null;
  readonly quantidade: number;
  readonly totalPrevisto: number;
  readonly totalRealizado: number;
  readonly atrasadasCount: number;
}

export const DESPESAS_PERIODO_VAZIO: ResumoDespesasPeriodo = {
  despesasFixas: null,
  despesasVariaveis: null,
  quantidade: 0,
  totalPrevisto: 0,
  totalRealizado: 0,
  atrasadasCount: 0,
};

export interface ResumoRegimeCaixa {
  readonly pagoNoCaixa: number;
  readonly aVencerEmAberto: number;
  readonly vencidasEmAtraso: number;
  readonly qtdPagas: number;
  readonly qtdAVencer: number;
  readonly qtdAtrasadas: number;
}

/**
 * Consolida a visão de Regime de Caixa (saídas efetivamente pagas, compromissos
 * a vencer e contas em atraso) separadamente do Regime de Competência da DRE.
 */
export function resumirRegimeCaixa(
  despesas: readonly {
    readonly status: StatusDespesa;
    readonly planned_amount: number | string;
    readonly actual_amount: number | string | null;
    readonly due_date: string | null;
  }[],
  hoje: string,
): ResumoRegimeCaixa {
  let pagoNoCaixa = 0;
  let aVencerEmAberto = 0;
  let vencidasEmAtraso = 0;
  let qtdPagas = 0;
  let qtdAVencer = 0;
  let qtdAtrasadas = 0;

  for (const d of despesas) {
    if (d.status === "cancelada") continue;

    const valor = d.actual_amount !== null ? Number(d.actual_amount) : Number(d.planned_amount);
    if (!Number.isFinite(valor) || valor < 0) continue;

    if (d.status === "paga") {
      pagoNoCaixa += valor;
      qtdPagas += 1;
    } else if (d.status === "atrasada" || (d.due_date !== null && d.due_date < hoje)) {
      vencidasEmAtraso += valor;
      qtdAtrasadas += 1;
    } else {
      aVencerEmAberto += valor;
      qtdAVencer += 1;
    }
  }

  return {
    pagoNoCaixa: Math.round(pagoNoCaixa * 100) / 100,
    aVencerEmAberto: Math.round(aVencerEmAberto * 100) / 100,
    vencidasEmAtraso: Math.round(vencidasEmAtraso * 100) / 100,
    qtdPagas,
    qtdAVencer,
    qtdAtrasadas,
  };
}

/** Calcula o primeiro dia do mês seguinte (YYYY-MM-01 -> YYYY-MM-01). */
export function proximoMes(mesYm: string): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(mesYm.trim());
  if (m === null) return null;
  const ano = Number(m[1]);
  const mes = Number(m[2]);
  if (mes < 1 || mes > 12) return null;
  const proxAno = mes === 12 ? ano + 1 : ano;
  const proxMes = mes === 12 ? 1 : mes + 1;
  return `${String(proxAno)}-${String(proxMes).padStart(2, "0")}-01`;
}

/**
 * Soma as despesas operacionais (fixas e variáveis) que pertencem ao intervalo
 * `[from, to]`. Despesas canceladas são ignoradas; quando `actual_amount`
 * está preenchido, prevalece sobre `planned_amount`.
 *
 * Retorna `null` para fixas (ou variáveis) quando não há nenhuma despesa
 * lançada daquele tipo no intervalo — para que a DRE sinalize a ausência de
 * cadastro em vez de fingir R$ 0,00 silenciosamente.
 */
export function agregarDespesasNoPeriodo(
  despesas: readonly {
    readonly cost_type: ClassificacaoCusto;
    readonly status: StatusDespesa;
    readonly planned_amount: number | string;
    readonly actual_amount: number | string | null;
    readonly competence_date: string;
    readonly due_date?: string | null;
  }[],
  from: string,
  to: string,
  hoje: string = to,
): ResumoDespesasPeriodo {
  let fixas = 0;
  let variaveis = 0;
  let qtdFixas = 0;
  let qtdVariaveis = 0;
  let totalPrevisto = 0;
  let totalRealizado = 0;
  let atrasadasCount = 0;

  for (const d of despesas) {
    if (d.status === "cancelada") continue;
    if (d.competence_date < from || d.competence_date > to) continue;

    const previsto = Number(d.planned_amount);
    const realizado = d.actual_amount !== null ? Number(d.actual_amount) : null;
    const valorBruto = realizado ?? previsto;
    if (!Number.isFinite(valorBruto) || valorBruto < 0) continue;

    if (Number.isFinite(previsto) && previsto >= 0) totalPrevisto += previsto;
    if (realizado !== null && Number.isFinite(realizado) && realizado >= 0) totalRealizado += realizado;
    if (d.status === "atrasada" || (d.status === "prevista" && d.due_date != null && d.due_date < hoje)) {
      atrasadasCount += 1;
    }

    if (d.cost_type === "fixo") {
      fixas += valorBruto;
      qtdFixas += 1;
    } else {
      variaveis += valorBruto;
      qtdVariaveis += 1;
    }
  }

  return {
    despesasFixas: qtdFixas > 0 ? Math.round(fixas * 100) / 100 : null,
    despesasVariaveis: qtdVariaveis > 0 ? Math.round(variaveis * 100) / 100 : null,
    quantidade: qtdFixas + qtdVariaveis,
    totalPrevisto: Math.round(totalPrevisto * 100) / 100,
    totalRealizado: Math.round(totalRealizado * 100) / 100,
    atrasadasCount,
  };
}

export interface DespesasComparadas {
  readonly atual: ResumoDespesasPeriodo;
  readonly anterior: ResumoDespesasPeriodo;
}

export const DESPESAS_COMPARADAS_VAZIAS: DespesasComparadas = {
  atual: DESPESAS_PERIODO_VAZIO,
  anterior: DESPESAS_PERIODO_VAZIO,
};

function lerBlocoResumoRpc(raw: unknown): ResumoDespesasPeriodo | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const numOuNulo = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  };
  const numObrigatorio = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const quantidade = numObrigatorio(r.quantidade);
  const totalPrevisto = numObrigatorio(r.total_previsto);
  const totalRealizado = numObrigatorio(r.total_realizado);
  const atrasadas = numObrigatorio(r.atrasadas);
  if (quantidade === null || totalPrevisto === null || totalRealizado === null || atrasadas === null) {
    return null;
  }

  return {
    despesasFixas: numOuNulo(r.despesas_fixas),
    despesasVariaveis: numOuNulo(r.despesas_variaveis),
    quantidade: Math.trunc(quantidade),
    totalPrevisto: Math.round(totalPrevisto * 100) / 100,
    totalRealizado: Math.round(totalRealizado * 100) / 100,
    atrasadasCount: Math.trunc(atrasadas),
  };
}

/** Valida e converte o JSONB devolvido por `public.get_resumo_despesas`. */
export function lerResumoDespesasRpc(raw: unknown): DespesasComparadas | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const atual = lerBlocoResumoRpc(r.atual);
  const anterior = lerBlocoResumoRpc(r.anterior);
  if (atual === null || anterior === null) return null;
  return { atual, anterior };
}

/**
 * Lê o resumo agregado das despesas operacionais (atual e anterior) via RPC
 * `public.get_resumo_despesas` (agregação 100% em SQL, sem risco de truncamento
 * em 1.000 linhas). Se a RPC ainda não existir no banco (`PGRST202`, deploy
 * web antes da migration `20261126210000`), cai com segurança para leitura
 * filtrada; se a tabela também não existir (`PGRST205`/`42P01`), devolve nulos.
 */
export async function carregarDespesasComparadas(
  supabase: unknown,
  organizationId: string | null,
  atualFrom: string,
  atualTo: string,
  anteriorFrom: string,
  anteriorTo: string,
): Promise<DespesasComparadas> {
  if (organizationId === null) return DESPESAS_COMPARADAS_VAZIAS;

  try {
    const client = supabase as {
      rpc?: (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { code?: string } | null }>;
      from: (table: string) => {
        select: (cols: string) => {
          eq: (c: string, v: string) => {
            gte: (c: string, v: string) => {
              lte: (c: string, v: string) => {
                limit: (n: number) => Promise<{
                  data:
                    | readonly {
                        readonly cost_type: ClassificacaoCusto;
                        readonly status: StatusDespesa;
                        readonly planned_amount: number | string;
                        readonly actual_amount: number | string | null;
                        readonly competence_date: string;
                        readonly due_date: string | null;
                      }[]
                    | null;
                  error: { code?: string } | null;
                }>;
              };
            };
          };
        };
      };
    };

    if (typeof client.rpc === "function") {
      const rpcRes = await client.rpc("get_resumo_despesas", {
        p_organization_id: organizationId,
        p_from: atualFrom,
        p_to: atualTo,
        p_anterior_from: anteriorFrom,
        p_anterior_to: anteriorTo,
      });

      if (rpcRes.error === null) {
        const parsed = lerResumoDespesasRpc(rpcRes.data);
        if (parsed !== null) return parsed;
      } else if (rpcRes.error.code !== "PGRST202") {
        return DESPESAS_COMPARADAS_VAZIAS;
      }
    }

    const minFrom = atualFrom < anteriorFrom ? atualFrom : anteriorFrom;
    const maxTo = atualTo > anteriorTo ? atualTo : anteriorTo;

    const { data, error } = await client
      .from("operational_expenses")
      .select("cost_type, status, planned_amount, actual_amount, competence_date, due_date")
      .eq("organization_id", organizationId)
      .gte("competence_date", minFrom)
      .lte("competence_date", maxTo)
      .limit(1000);

    if (error !== null || data === null) return DESPESAS_COMPARADAS_VAZIAS;

    return {
      atual: agregarDespesasNoPeriodo(data, atualFrom, atualTo),
      anterior: agregarDespesasNoPeriodo(data, anteriorFrom, anteriorTo),
    };
  } catch {
    return DESPESAS_COMPARADAS_VAZIAS;
  }
}

/**
 * Lê as despesas operacionais do período para alimentar a DRE e metas.
 * Reutiliza `carregarDespesasComparadas` (agregação em SQL via RPC).
 */
export async function carregarDespesasDoPeriodo(
  supabase: unknown,
  organizationId: string | null,
  from: string,
  to: string,
): Promise<ResumoDespesasPeriodo> {
  const res = await carregarDespesasComparadas(supabase, organizationId, from, to, from, to);
  return res.atual;
}

/**
 * Lê o faturamento bruto agregado em SQL por conta do Mercado Livre
 * (`get_faturamento_por_conta`) para ponderar o rateio de despesas compartilhadas.
 */
export async function carregarFaturamentoPorConta(
  supabase: unknown,
  organizationId: string | null,
  from: string,
  to: string,
): Promise<ReadonlyMap<string, number>> {
  const mapa = new Map<string, number>();
  if (organizationId === null) return mapa;

  try {
    const client = supabase as {
      rpc?: (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{
        data: readonly { readonly ml_account_id: string; readonly receita_bruta: number | string }[] | null;
        error: { code?: string } | null;
      }>;
    };
    if (typeof client.rpc !== "function") return mapa;

    const { data, error } = await client.rpc("get_faturamento_por_conta", {
      p_organization_id: organizationId,
      p_from: from,
      p_to: to,
    });
    if (error !== null || data === null) return mapa;

    for (const row of data) {
      const valor = Number(row.receita_bruta);
      if (Number.isFinite(valor) && valor > 0) {
        mapa.set(row.ml_account_id, Math.round(valor * 100) / 100);
      }
    }
  } catch {
    return mapa;
  }

  return mapa;
}

export interface EntidadeFiscalDaConta {
  readonly id: string;
  readonly nome: string;
  readonly cnpj: string;
  readonly regime: RegimeTributario;
  readonly configVigente: ConfiguracaoTributaria | null;
}

export interface ContextoFiscalDre {
  readonly totalEntidadesAtivas: number;
  readonly entidadeDaConta: EntidadeFiscalDaConta | null;
}

export const CONTEXTO_FISCAL_VAZIO: ContextoFiscalDre = {
  totalEntidadesAtivas: 0,
  entidadeDaConta: null,
};

/**
 * Carrega o contexto fiscal multi-CNPJ da organização e, quando uma conta do ML
 * estiver selecionada, resolve o CNPJ vinculado e sua vigência tributária ativa
 * na data de referência (`valid_from <= dataReferencia`). Nunca rejeita.
 */
export async function carregarContextoFiscal(
  supabase: unknown,
  organizationId: string | null,
  mlAccountId: string | null,
  dataReferencia: string,
): Promise<ContextoFiscalDre> {
  if (organizationId === null) return CONTEXTO_FISCAL_VAZIO;

  try {
    const db = supabase as {
      from: (table: string) => {
        select: (cols: string) => {
          eq: (c: string, v: string) => {
            limit: (n: number) => Promise<{ data: readonly Record<string, unknown>[] | null; error: { code?: string } | null }>;
          };
        };
      };
    };

    const [entidadesRes, vinculosRes, vigenciasRes] = await Promise.all([
      db
        .from("fiscal_entities")
        .select("id, legal_name, trade_name, cnpj, tax_regime, active")
        .eq("organization_id", organizationId)
        .limit(50),
      mlAccountId === null
        ? Promise.resolve({ data: [], error: null })
        : db
            .from("fiscal_entity_accounts")
            .select("fiscal_entity_id, ml_account_id")
            .eq("organization_id", organizationId)
            .limit(100),
      mlAccountId === null
        ? Promise.resolve({ data: [], error: null })
        : db
            .from("fiscal_entity_tax_configs")
            .select(
              "id, fiscal_entity_id, tax_regime, valid_from, nominal_rate, effective_sales_rate, tax_credits_rate, profit_tax_rate, validated_by_accountant",
            )
            .eq("organization_id", organizationId)
            .limit(100),
    ]);

    if (entidadesRes.error !== null || entidadesRes.data === null) return CONTEXTO_FISCAL_VAZIO;

    const entidadesAtivas = entidadesRes.data.filter((e) => e.active === true);
    const totalEntidadesAtivas = entidadesAtivas.length;

    if (mlAccountId === null || vinculosRes.error !== null || vigenciasRes.error !== null) {
      return { totalEntidadesAtivas, entidadeDaConta: null };
    }

    const vinculo = (vinculosRes.data ?? []).find((v) => v.ml_account_id === mlAccountId);
    const entityId = typeof vinculo?.fiscal_entity_id === "string" ? vinculo.fiscal_entity_id : null;
    if (entityId === null) {
      return { totalEntidadesAtivas, entidadeDaConta: null };
    }

    const ent = entidadesAtivas.find((e) => e.id === entityId);
    if (ent === undefined) {
      return { totalEntidadesAtivas, entidadeDaConta: null };
    }

    const configs: ConfiguracaoTributaria[] = (vigenciasRes.data ?? [])
      .filter((c) => c.fiscal_entity_id === entityId)
      .map((c) => ({
        id: String(c.id),
        entityId,
        regime: c.tax_regime as RegimeTributario,
        validFrom: String(c.valid_from),
        aliquotaNominal: Number(c.nominal_rate),
        aliquotaEfetivaVendas: Number(c.effective_sales_rate),
        creditosTributariosFracao: Number(c.tax_credits_rate),
        aliquotaSobreLucro: Number(c.profit_tax_rate),
        validadoContabilidade: Boolean(c.validated_by_accountant),
      }));

    const configVigente = selecionarConfigTributariaVigente(configs, dataReferencia);

    return {
      totalEntidadesAtivas,
      entidadeDaConta: {
        id: entityId,
        nome: typeof ent.trade_name === "string" && ent.trade_name.trim() !== "" ? ent.trade_name : String(ent.legal_name),
        cnpj: String(ent.cnpj),
        regime: ent.tax_regime as RegimeTributario,
        configVigente,
      },
    };
  } catch {
    return CONTEXTO_FISCAL_VAZIO;
  }
}
