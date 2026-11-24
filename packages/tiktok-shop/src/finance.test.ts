import { describe, expect, it, vi } from "vitest";

import { createTikTokShopClient } from "./client.js";
import {
  FINANCE_MAX_PAGE_SIZE,
  getOrderStatementTransactions,
  getStatementsPage,
  getUnsettledOrdersPage,
} from "./finance.js";

const NOW = new Date("2026-11-24T12:00:00.000Z");
const SHOP = { accessToken: "token-vendedor", shopCipher: "ROW_cipher_1" };

function clienteCom(corpo: unknown) {
  const chamadas: { url: URL; init: RequestInit | undefined }[] = [];
  const fetchImpl = vi.fn((url: URL, init?: RequestInit) => {
    chamadas.push({ url, init });

    return Promise.resolve(new Response(JSON.stringify(corpo), { status: 200 }));
  });
  const client = createTikTokShopClient({
    appKey: "chave-teste",
    appSecret: "segredo-teste",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => NOW,
  });

  return { client, chamadas };
}

describe("financeiro do TikTok Shop (§7)", () => {
  it("lê extratos diários GET /finance/202309/statements e valida página/janela", async () => {
    const { client, chamadas } = clienteCom({
      code: 0,
      data: {
        next_page_token: "st-2",
        statements: [
          {
            id: "stmt-1",
            statement_time: 1700000000,
            settlement_amount: "180.50",
            revenue_amount: "200.00",
            fee_amount: "-19.50",
            adjustment_amount: "0.00",
            shipping_cost_amount: "0.00",
            currency: "BRL",
            payment_status: "PAID",
          },
        ],
      },
    });

    const page = await getStatementsPage(client, SHOP, {
      statementTimeGe: 1700000000,
      statementTimeLt: 1700086400,
      paymentStatus: "PAID",
      pageSize: 50,
    });

    expect(page.nextPageToken).toBe("st-2");
    expect(page.statements[0]?.id).toBe("stmt-1");
    expect(chamadas[0]?.url.pathname).toBe("/finance/202309/statements");
    expect(chamadas[0]?.url.searchParams.get("payment_status")).toBe("PAID");

    await expect(getStatementsPage(client, SHOP, { pageSize: FINANCE_MAX_PAGE_SIZE + 1 })).rejects.toThrow(RangeError);
    await expect(
      getStatementsPage(client, SHOP, { statementTimeGe: 1700086400, statementTimeLt: 1700000000 }),
    ).rejects.toThrow(RangeError);
  });

  it("lê transações por pedido GET /finance/202501/orders/{order_id}/statement_transactions incluindo taxa BR", async () => {
    const { client, chamadas } = clienteCom({
      code: 0,
      data: {
        order_id: "576461413038785752",
        currency: "BRL",
        revenue_amount: "199.90",
        settlement_amount: "165.40",
        fee_and_tax_amount: "-34.50",
        shipping_cost_amount: "0.00",
        sku_transactions: [
          {
            sku_id: "sku-a",
            sku_name: "Capacete",
            quantity: 2,
            settlement_amount: "165.40",
            revenue_amount: "199.90",
            fee_and_tax_amount: "-34.50",
            fee_per_item_sold_amount: "-8.00",
            referral_fee_amount: "-20.00",
            transaction_fee_amount: "-6.50",
          },
        ],
      },
    });

    const tx = await getOrderStatementTransactions(client, SHOP, "576461413038785752");

    expect(tx.order_id).toBe("576461413038785752");
    expect(tx.sku_transactions?.[0]?.fee_per_item_sold_amount).toBe("-8.00");
    expect(chamadas[0]?.url.pathname).toBe("/finance/202501/orders/576461413038785752/statement_transactions");

    await expect(getOrderStatementTransactions(client, SHOP, "../bad")).rejects.toThrow(RangeError);
  });

  it("lê pedidos não liquidados GET /finance/202507/orders/unsettled e barra cursor repetido", async () => {
    const { client, chamadas } = clienteCom({
      code: 0,
      data: {
        next_page_token: "u-2",
        total_count: 3,
        orders: [
          {
            order_id: "576461413038785752",
            currency: "BRL",
            est_settlement_amount: "165.40",
            est_revenue_amount: "199.90",
            est_fee_amount: "-34.50",
          },
        ],
      },
    });

    const page = await getUnsettledOrdersPage(client, SHOP, { pageSize: 20 });

    expect(page.totalCount).toBe(3);
    expect(page.orders[0]?.est_settlement_amount).toBe("165.40");
    expect(chamadas[0]?.url.pathname).toBe("/finance/202507/orders/unsettled");

    await expect(getUnsettledOrdersPage(client, SHOP, { pageToken: "u-2" })).rejects.toThrow(/cursor repetido/i);
  });
});
