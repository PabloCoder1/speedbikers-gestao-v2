import { describe, expect, it } from "vitest";

import {
  carregarFaturamentoPorConta,
  agregarDespesasNoPeriodo,
  lerCnpj,
  lerFormularioDespesa,
  lerFormularioEntidadeFiscal,
  lerFormularioVigenciaTributaria,
  lerResumoDespesasRpc,
  proximoMes,
  resumirRegimeCaixa,
} from "./custos-fiscal";

describe("lerCnpj", () => {
  it("aceita CNPJ formatado ou apenas dígitos com DV válido", () => {
    // 11.222.333/0001-81 é um CNPJ matematicamente válido
    expect(lerCnpj("11.222.333/0001-81")).toEqual({ ok: true, valor: "11222333000181" });
    expect(lerCnpj("11222333000181")).toEqual({ ok: true, valor: "11222333000181" });
  });

  it("recusa CNPJ com tamanho errado, dígitos repetidos ou DV inválido", () => {
    expect(lerCnpj("123456").ok).toBe(false);
    expect(lerCnpj("11.111.111/1111-11").ok).toBe(false);
    expect(lerCnpj("11.222.333/0001-82").ok).toBe(false);
  });
});

describe("lerFormularioDespesa", () => {
  it("valida uma despesa completa com valores pt-BR", () => {
    const campos: Record<string, string> = {
      name: "Aluguel do galpão",
      category: "aluguel",
      cost_type: "fixo",
      recurrence: "mensal",
      allocation_method: "faturamento",
      planned_amount: "8.500,00",
      actual_amount: "8.500,00",
      competence_date: "2026-11-01",
      due_date: "2026-11-10",
      paid_date: "2026-11-09",
      status: "paga",
      marketplace: "TODOS",
      cost_center: "Operação",
      note: "Contrato anual",
    };

    const res = lerFormularioDespesa((k) => campos[k] ?? "");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.valor.planned_amount).toBe(8500);
      expect(res.valor.actual_amount).toBe(8500);
      expect(res.valor.cost_type).toBe("fixo");
    }
  });

  it("devolve erros de campo quando dados obrigatórios são inválidos", () => {
    const res = lerFormularioDespesa(() => "");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.erros.name).toBeDefined();
      expect(res.erros.category).toBeDefined();
      expect(res.erros.planned_amount).toBeDefined();
    }
  });
});

describe("lerFormularioEntidadeFiscal e lerFormularioVigenciaTributaria", () => {
  it("valida CNPJ e vigência do Lucro Real com créditos", () => {
    const ent = lerFormularioEntidadeFiscal((k) =>
      ({
        legal_name: "Speed Bikers Comércio LTDA",
        trade_name: "Speed Bikers",
        cnpj: "11.222.333/0001-81",
        tax_regime: "lucro_real",
        note: "Matriz",
      })[k] ?? "",
    );
    expect(ent.ok).toBe(true);

    const vig = lerFormularioVigenciaTributaria((k) =>
      ({
        fiscal_entity_id: "ent-1",
        tax_regime: "lucro_real",
        valid_from: "2026-01-01",
        nominal_rate: "27,25",
        effective_sales_rate: "27,25",
        tax_credits_rate: "12,5",
        profit_tax_rate: "24",
        validated_by_accountant: "on",
        source_note: "Validado pela contabilidade",
      })[k] ?? "",
    );
    expect(vig.ok).toBe(true);
    if (vig.ok) {
      expect(vig.valor.tax_credits_rate).toBeCloseTo(0.125, 6);
      expect(vig.valor.validated_by_accountant).toBe(true);
    }
  });
});

describe("agregarDespesasNoPeriodo", () => {
  it("separa fixas e variáveis no intervalo, prioriza realizado, ignora canceladas e retorna null sem lançamento", () => {
    const res = agregarDespesasNoPeriodo(
      [
        { cost_type: "fixo", status: "paga", planned_amount: 5000, actual_amount: 5200, competence_date: "2026-11-05" },
        { cost_type: "fixo", status: "prevista", planned_amount: 1000, actual_amount: null, competence_date: "2026-11-15" },
        { cost_type: "fixo", status: "cancelada", planned_amount: 9000, actual_amount: 9000, competence_date: "2026-11-10" },
        { cost_type: "fixo", status: "paga", planned_amount: 4000, actual_amount: 4000, competence_date: "2026-10-05" },
      ],
      "2026-11-01",
      "2026-11-30",
    );

    expect(res.despesasFixas).toBe(6200);
    expect(res.despesasVariaveis).toBeNull();
    expect(res.quantidade).toBe(2);
  });
});

describe("resumirRegimeCaixa e proximoMes", () => {
  it("separa pagas, a vencer e vencidas em atraso sem contar canceladas", () => {
    const caixa = resumirRegimeCaixa(
      [
        { status: "paga", planned_amount: 1000, actual_amount: 1100, due_date: "2026-11-05" },
        { status: "prevista", planned_amount: 500, actual_amount: null, due_date: "2026-11-30" },
        { status: "prevista", planned_amount: 700, actual_amount: null, due_date: "2026-11-10" },
        { status: "atrasada", planned_amount: 300, actual_amount: null, due_date: "2026-11-01" },
        { status: "cancelada", planned_amount: 9999, actual_amount: 9999, due_date: "2026-11-01" },
      ],
      "2026-11-26",
    );

    expect(caixa.pagoNoCaixa).toBe(1100);
    expect(caixa.aVencerEmAberto).toBe(500);
    expect(caixa.vencidasEmAtraso).toBe(1000);
    expect(caixa.qtdPagas).toBe(1);
    expect(caixa.qtdAVencer).toBe(1);
    expect(caixa.qtdAtrasadas).toBe(2);
  });

  it("calcula corretamente a virada de mês e de ano", () => {
    expect(proximoMes("2026-11")).toBe("2026-12-01");
    expect(proximoMes("2026-12")).toBe("2027-01-01");
    expect(proximoMes("invalido")).toBeNull();
  });
});

describe("lerResumoDespesasRpc", () => {
  it("converte o JSONB de get_resumo_despesas preservando nulos e rejeitando payloads inválidos", () => {
    const parsed = lerResumoDespesasRpc({
      atual: {
        despesas_fixas: 6200,
        despesas_variaveis: null,
        quantidade: 2,
        total_previsto: 6000,
        total_realizado: 5200,
        atrasadas: 1,
      },
      anterior: {
        despesas_fixas: null,
        despesas_variaveis: 800,
        quantidade: 1,
        total_previsto: 750,
        total_realizado: 800,
        atrasadas: 0,
      },
    });

    expect(parsed).toEqual({
      atual: {
        despesasFixas: 6200,
        despesasVariaveis: null,
        quantidade: 2,
        totalPrevisto: 6000,
        totalRealizado: 5200,
        atrasadasCount: 1,
      },
      anterior: {
        despesasFixas: null,
        despesasVariaveis: 800,
        quantidade: 1,
        totalPrevisto: 750,
        totalRealizado: 800,
        atrasadasCount: 0,
      },
    });

    expect(lerResumoDespesasRpc(null)).toBeNull();
    expect(lerResumoDespesasRpc({ atual: {} })).toBeNull();
  });
});

describe("carregarFaturamentoPorConta", () => {
  interface Resposta {
    data: readonly Record<string, unknown>[] | null;
    error: { code?: string } | null;
  }
  const cliente = (respostas: Record<string, Resposta>): { rpc: (fn: string) => Promise<Resposta>; chamadas: string[] } => {
    const chamadas: string[] = [];
    return {
      chamadas,
      rpc: (fn: string) => {
        chamadas.push(fn);
        return Promise.resolve(respostas[fn] ?? { data: null, error: { code: "PGRST202" } });
      },
    };
  };

  it("lê ML e Shopee pela função multicanal, com a referência da tela como chave", async () => {
    const c = cliente({
      get_faturamento_por_conta_multicanal: {
        data: [
          { marketplace: "MERCADO_LIVRE", conta_id: "ml-1", receita_bruta: "1000.00" },
          { marketplace: "SHOPEE", conta_id: "loja-1", receita_bruta: 400 },
          { marketplace: "SHOPEE", conta_id: "loja-2", receita_bruta: "0" },
          { marketplace: "SHOPEE", conta_id: "loja-3", receita_bruta: null },
          { marketplace: "OUTRO", conta_id: "x", receita_bruta: 10 },
        ],
        error: null,
      },
    });
    const mapa = await carregarFaturamentoPorConta(c, "org", "2026-11-01", "2026-11-30");
    expect([...mapa.entries()]).toEqual([
      ["MERCADO_LIVRE:ml-1", 1000],
      ["SHOPEE:loja-1", 400],
    ]);
    expect(c.chamadas).toEqual(["get_faturamento_por_conta_multicanal"]);
  });

  it("sem a função nova no banco, cai na antiga, só do ML", async () => {
    const c = cliente({
      get_faturamento_por_conta: { data: [{ ml_account_id: "ml-1", receita_bruta: "250.5" }], error: null },
    });
    const mapa = await carregarFaturamentoPorConta(c, "org", "2026-11-01", "2026-11-30");
    expect([...mapa.entries()]).toEqual([["MERCADO_LIVRE:ml-1", 250.5]]);
    expect(c.chamadas).toEqual(["get_faturamento_por_conta_multicanal", "get_faturamento_por_conta"]);
  });

  it("sem organização ou com as duas falhando, devolve o mapa vazio", async () => {
    expect((await carregarFaturamentoPorConta(cliente({}), null, "2026-11-01", "2026-11-30")).size).toBe(0);
    expect((await carregarFaturamentoPorConta(cliente({}), "org", "2026-11-01", "2026-11-30")).size).toBe(0);
  });
});
