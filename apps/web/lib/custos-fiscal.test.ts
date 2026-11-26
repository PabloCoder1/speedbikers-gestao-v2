import { describe, expect, it } from "vitest";

import {
  agregarDespesasNoPeriodo,
  lerCnpj,
  lerFormularioDespesa,
  lerFormularioEntidadeFiscal,
  lerFormularioVigenciaTributaria,
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
