import { describe, expect, it } from "vitest";

import { formatCurrency } from "./format";
import { entityHref, entityLabel, entityText, eventOriginLabel, formatEventDiff, scalar } from "./event-format";

describe("formatEventDiff", () => {
  it("listing.price.changed formata os dois lados como moeda", () => {
    // `formatCurrency` (não um literal de string) monta o esperado: o
    // Intl.NumberFormat do Node usa espaço não separável (U+00A0) entre
    // "R$" e o valor — um literal digitado à mão usaria espaço normal e
    // falharia por um caractere invisível diferente.
    expect(formatEventDiff("listing.price.changed", { price: 399.9 }, { price: 379.9 })).toBe(
      `${formatCurrency(399.9)} → ${formatCurrency(379.9)}`,
    );
  });

  it("listing.title.changed cerca os dois lados em aspas", () => {
    expect(formatEventDiff("listing.title.changed", { title: "Capacete X" }, { title: "Capacete Y" })).toBe(
      '"Capacete X" → "Capacete Y"',
    );
  });

  it("listing.available_quantity.changed mostra os números brutos", () => {
    expect(formatEventDiff("listing.available_quantity.changed", { availableQuantity: 10 }, { availableQuantity: 0 })).toBe(
      "10 → 0",
    );
  });

  it("listing.status.paused traduz os dois lados pelo rótulo de status", () => {
    expect(formatEventDiff("listing.status.paused", { status: "active" }, { status: "paused" })).toBe(
      "Ativo → Pausado",
    );
  });

  it("listing.status.reactivated também traduz pelo rótulo de status", () => {
    expect(formatEventDiff("listing.status.reactivated", { status: "paused" }, { status: "active" })).toBe(
      "Pausado → Ativo",
    );
  });

  it("before/after nulo não quebra — cai no traço padrão dos dois lados", () => {
    expect(formatEventDiff("listing.price.changed", null, null)).toBe(`${formatCurrency(null)} → ${formatCurrency(null)}`);
  });

  it("tipo de evento sem formato documentado retorna null, não inventa leitura", () => {
    expect(formatEventDiff("order.cancelled", { status: "confirmed" }, { status: "cancelled" })).toBeNull();
    expect(formatEventDiff("stock.depleted", { quantity: 5 }, { quantity: 0 })).toBeNull();
  });
});

describe("scalar", () => {
  it("string e number passam direto", () => {
    expect(scalar("ativo")).toBe("ativo");
    expect(scalar(42)).toBe("42");
  });

  it("objeto, array, null e undefined viram o traço padrão, nunca '[object Object]'", () => {
    expect(scalar({ a: 1 })).toBe("—");
    expect(scalar([1, 2])).toBe("—");
    expect(scalar(null)).toBe("—");
    expect(scalar(undefined)).toBe("—");
  });
});

describe("entityHref", () => {
  it("sku vira link pro Dashboard de SKU", () => {
    expect(entityHref("sku", "abc-123")).toBe("/skus/abc-123");
  });

  /**
   * `entity_id` de um evento de anúncio é o `item_id` (o MLB), que é o
   * parâmetro da rota `/anuncios/[itemId]` — a mesma chave que o Dashboard do
   * Anúncio usa para se achar. A rota existe desde D-168; o link só entrou em
   * D13, quando a migração da tela releu o registro envelhecido que dizia
   * "anúncio ainda não tem tela própria".
   */
  it("listing vira link pro Dashboard do Anúncio, pelo MLB", () => {
    expect(entityHref("listing", "MLB123")).toBe("/anuncios/MLB123");
  });

  /**
   * A guarda que impede o link quebrado: `listing.fulfillment.entered` grava o
   * `inventoryId` em `entity_id` com `entity_type = "listing"`, e inventory e
   * item são identificadores diferentes (`fulfillment_stock_snapshots` guarda
   * os dois em colunas separadas). Sem conferir o formato, essa notificação
   * apontaria para uma página que não existe.
   */
  it("listing cujo entity_id NÃO é um MLB não vira link — é o inventory_id do evento de Full", () => {
    expect(entityHref("listing", "INV-88231")).toBeNull();
    expect(entityHref("listing", "88231")).toBeNull();
  });

  it("order continua sem tela própria — sem link", () => {
    expect(entityHref("order", "999")).toBeNull();
  });
});

describe("entityLabel", () => {
  it("traduz os três tipos conhecidos e cai no código bruto pros demais", () => {
    expect(entityLabel("sku")).toBe("SKU");
    expect(entityLabel("listing")).toBe("Anúncio");
    expect(entityLabel("order")).toBe("Pedido");
    expect(entityLabel("inventory")).toBe("inventory");
  });
});

/** D-411: o alerta novo da central, como `sincronizar_alertas_central` grava o `after`. */
describe("central.alert.opened (D-411)", () => {
  const ALERTA = { kind: "frete_anomalo", mlb_id: "MLB9700031", impacto: 123.45 };

  it("o texto diz o tipo do alerta e o impacto estimado, quando há", () => {
    expect(formatEventDiff("central.alert.opened", null, ALERTA)?.replace(/\s/g, " ")).toBe(
      "Frete anômalo · R$ 123,45 de impacto estimado",
    );
    expect(formatEventDiff("central.alert.opened", null, { kind: "produto_prejuizo", impacto: null })).toBe(
      "Produto no prejuízo",
    );
    expect(formatEventDiff("central.alert.opened", null, null)).toBeNull();
  });

  it("o link é a fila de ações filtrada pelo tipo; sem o tipo, a fila inteira", () => {
    expect(entityHref("action", "3f2a", ALERTA)).toBe("/acoes?tipo=frete_anomalo");
    expect(entityHref("action", "3f2a")).toBe("/acoes");
  });

  it("o destino nomeia o alerta, não o uuid da ação", () => {
    expect(entityText("action", "3f2a", ALERTA)).toBe("Frete anômalo · MLB9700031");
    expect(entityText("action", "3f2a", { kind: "ads_campanha" })).toBe("Campanha de Ads");
    expect(entityText("listing", "MLB123")).toBe("Anúncio MLB123");
  });
});

/** D-417: a conta que parou de sincronizar, como os gatilhos gravam o `after`. */
describe("sync.delayed / sync.failed (D-417)", () => {
  const RECONCILIACAO = { tipo: "reconciliacao", label: "GMR", horas: 5, motivo: "Mercado Livre respondeu 403 para GET /orders/search." };
  const CONTA_EM_ERRO = { tipo: "conta_em_erro", label: "SbMotos", motivo: "Mercado Livre recusou a troca de token: invalid_grant." };

  it("o texto diz há quanto tempo e por quê; a conta em erro diz o motivo ou o que fazer", () => {
    expect(formatEventDiff("sync.delayed", null, RECONCILIACAO)).toBe(
      "Pedidos sem sincronizar há 5 h · Mercado Livre respondeu 403 para GET /orders/search.",
    );
    expect(formatEventDiff("sync.failed", null, { ...RECONCILIACAO, horas: 13, motivo: null })).toBe(
      "Pedidos sem sincronizar há 13 h",
    );
    expect(formatEventDiff("sync.failed", { status: "CONNECTED" }, CONTA_EM_ERRO)).toBe(
      "Conta em erro: Mercado Livre recusou a troca de token: invalid_grant.",
    );
    expect(formatEventDiff("sync.failed", null, { tipo: "conta_em_erro", label: "GMR", motivo: null })).toBe(
      "Conta em erro: reconecte em Integrações",
    );
    expect(formatEventDiff("sync.failed", null, { tipo: "outro" })).toBeNull();
  });

  it("o destino é a conta pelo nome, e o link leva a Integrações", () => {
    expect(entityText("ml_account", "aaaa-bbbb", RECONCILIACAO)).toBe("Conta GMR");
    expect(entityText("ml_account", "aaaa-bbbb")).toBe("Conta aaaa-bbbb");
    expect(entityHref("ml_account", "aaaa-bbbb")).toBe("/integracoes");
    expect(entityLabel("ml_account")).toBe("Conta");
  });
});

describe("a loja Shopee parada ou em erro (D-435, rótulos de D-438)", () => {
  const PARADA = { tipo: "reconciliacao", marketplace: "SHOPEE", label: "Speedbikers", horas: 14, motivo: null };

  it("o texto do vigia vale igual para a loja; a loja em erro manda reautorizar em Contas e lojas", () => {
    expect(formatEventDiff("sync.failed", null, PARADA)).toBe("Pedidos sem sincronizar há 14 h");
    expect(formatEventDiff("sync.failed", null, { tipo: "conta_em_erro", marketplace: "SHOPEE", label: "Speedbikers", motivo: null })).toBe(
      "Loja em erro: reautorize em Contas e lojas",
    );
    expect(
      formatEventDiff("sync.failed", null, { tipo: "conta_em_erro", marketplace: "SHOPEE", motivo: "refresh_token_expired" }),
    ).toBe("Loja em erro: refresh_token_expired");
  });

  it("o destino é a loja pelo nome, sem repetir o rótulo, e o link leva a Contas e lojas", () => {
    expect(entityText("shopee_shop", "cccc-dddd", PARADA)).toBe("Loja Shopee Speedbikers");
    expect(entityText("shopee_shop", "cccc-dddd", { ...PARADA, label: "Loja Shopee 990000001" })).toBe("Loja Shopee 990000001");
    expect(entityText("shopee_shop", "cccc-dddd")).toBe("Loja Shopee cccc-dddd");
    expect(entityHref("shopee_shop", "cccc-dddd")).toBe("/contas");
    expect(entityLabel("shopee_shop")).toBe("Loja Shopee");
  });
});

describe("a mudança de preço do anúncio da Shopee (C-81, D-638)", () => {
  // A forma do worker do A1: before = {price, current_price, model_id}; o after leva também os nomes.
  const ANTES = { price: 100, current_price: 90, model_id: 7001 };
  const DEPOIS = { price: 120, current_price: 120, model_id: 7001, model_name: "Preto", item_name: "Capacete X", shop_name: "Loja Shopee Real" };
  const LOJA = "aaaa-bbbb";

  it("o diff é o do ML: o price (original_price), nunca o current_price da promoção", () => {
    expect(formatEventDiff("listing.price.changed", ANTES, DEPOIS)).toBe(`${formatCurrency(100)} → ${formatCurrency(120)}`);
  });

  it("abre a lista da loja buscada pelo item, só com a loja e o item numérico", () => {
    expect(entityHref("shopee_item", "990777001", DEPOIS, LOJA)).toBe("/anuncios/shopee?loja=aaaa-bbbb&q=990777001");
    // Sem a loja (o evento antigo ou a coluna não lida), sem destino — nunca a tela do ML.
    expect(entityHref("shopee_item", "990777001", DEPOIS)).toBeNull();
    expect(entityHref("shopee_item", "MLB123", DEPOIS, LOJA)).toBeNull();
  });

  it("nomeia o anúncio e a variação quando vêm, e o item quando não", () => {
    expect(entityLabel("shopee_item")).toBe("Anúncio Shopee");
    expect(entityText("shopee_item", "990777001", DEPOIS)).toBe("Anúncio Shopee Capacete X · Preto");
    expect(entityText("shopee_item", "990777001", { ...DEPOIS, model_name: null })).toBe("Anúncio Shopee Capacete X");
    expect(entityText("shopee_item", "990777001", null)).toBe("Anúncio Shopee 990777001");
  });

  it("a origem é a conta do ML pelo embed, ou a loja pelo shop_name do evento", () => {
    expect(eventOriginLabel("Loja E2E", DEPOIS)).toBe("Loja E2E");
    expect(eventOriginLabel(null, DEPOIS)).toBe("Loja Shopee Real");
    expect(eventOriginLabel(undefined, { shop_name: "  " })).toBeNull();
    expect(eventOriginLabel(null, null)).toBeNull();
    // A loja sem nome lido (`shop_name` nulo): a loja da coluna diz que é da Shopee, sem inventar nome.
    expect(eventOriginLabel(null, { ...DEPOIS, shop_name: null }, LOJA)).toBe("Loja Shopee");
  });
});
