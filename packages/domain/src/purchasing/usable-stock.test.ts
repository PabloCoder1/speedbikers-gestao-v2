import { describe, expect, it } from "vitest";

import { computeUsableStock } from "./usable-stock.js";

const base = { localQuantity: 0, fullQuantity: 0, transitQuantity: 0, reservedQuantity: 0, stockIsVirtual: false };

describe("computeUsableStock", () => {
  it("soma LOCAL + FULL + TRÂNSITO", () => {
    const r = computeUsableStock({ ...base, localQuantity: 40, fullQuantity: 30, transitQuantity: 8 });

    expect(r.total).toBe(78);
    expect(r.reason).toBeNull();
  });

  /**
   * O invariante central da definição: RESERVADO é exposto mas NUNCA somado.
   * O "Disponível" do UpSeller já o exclui — no modelo da V3 os dois são
   * `location_kind` disjuntos desde a importação —, então somá-lo aqui
   * contaria unidades já comprometidas como disponíveis para vender.
   */
  it("RESERVADO fica fora do total, mas visível nos componentes", () => {
    const r = computeUsableStock({ ...base, localQuantity: 50, reservedQuantity: 10 });

    expect(r.total).toBe(50);
    expect(r.components.reservedExcluded).toBe(10);
  });

  /**
   * SKU virtual: o LOCAL é sentinela (999/9999), não contagem. Somar
   * sentinela com Full REAL produziria "1.029 aproveitáveis" com aparência
   * de precisão — a recusa é a resposta, mesmo desenho de D-127 na
   * cobertura. Full e trânsito continuam nos componentes: são reais.
   */
  it("SKU virtual recusa o total e diz por quê — mas expõe Full e trânsito", () => {
    const r = computeUsableStock({
      ...base,
      localQuantity: 999,
      fullQuantity: 30,
      transitQuantity: 5,
      stockIsVirtual: true,
    });

    expect(r.total).toBeNull();
    expect(r.reason).toBe("ESTOQUE_VIRTUAL");
    expect(r.components.full).toBe(30);
    expect(r.components.transit).toBe(5);
  });

  /**
   * LOCAL negativo entra NEGATIVO: -5 são unidades vendidas além do que o
   * ledger conhece — devidas. Truncar em zero esconderia a dívida e a
   * sugestão de compra deixaria de cobri-la. 191 SKUs estavam negativos
   * após o reparo de D-134; o número é real e merece aparecer na conta.
   */
  it("LOCAL negativo reduz o total em vez de ser truncado em zero", () => {
    const r = computeUsableStock({ ...base, localQuantity: -5, fullQuantity: 20 });

    expect(r.total).toBe(15);
    expect(r.components.local).toBe(-5);
  });

  it("tudo zero é total zero, não recusa — sem estoque é resposta válida", () => {
    const r = computeUsableStock(base);

    expect(r.total).toBe(0);
    expect(r.reason).toBeNull();
  });
});
