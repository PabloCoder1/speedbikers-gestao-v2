import "server-only";

import { getValidMercadoLivreAccessToken } from "@/integrations/mercado-livre/access-token";
import {
  searchSellerOrders,
  type MercadoLivreOrder,
} from "@/integrations/mercado-livre/orders";
import { createAdminClient } from "@/lib/supabase/admin";


type OrderBoundary = {
  id: string;
  dateCreated: string;
};


type MlAccountRow = {
  id: string;
  organization_id: string;
  display_name: string;
  seller_id: string | null;
  connection_status: string;
};


function getOrderBoundary(
  order:
    MercadoLivreOrder |
    undefined,
): OrderBoundary | null {
  if (!order) {
    return null;
  }


  const rawId =
    order.id;

  const rawDate =
    order.date_created;


  if (
    (
      typeof rawId !==
        "string" &&
      typeof rawId !==
        "number"
    ) ||
    typeof rawDate !==
      "string"
  ) {
    return null;
  }


  const timestamp =
    Date.parse(
      rawDate,
    );


  if (
    Number.isNaN(
      timestamp,
    )
  ) {
    return null;
  }


  return {
    id:
      String(rawId),

    dateCreated:
      new Date(
        timestamp,
      ).toISOString(),
  };
}


export async function getOrdersHistoryRange({
  organizationId,
  mlAccountId,
}: {
  organizationId: string;
  mlAccountId: string;
}) {
  const admin =
    createAdminClient();


  const {
    data: account,
    error: accountError,
  } = (await admin
    .from("ml_accounts")
    .select(
      [
        "id",
        "organization_id",
        "display_name",
        "seller_id",
        "connection_status",
      ].join(","),
    )
    .eq(
      "organization_id",
      organizationId,
    )
    .eq(
      "id",
      mlAccountId,
    )
    .maybeSingle()) as {
      data: MlAccountRow | null;
      error: unknown;
    };


  if (
    accountError ||
    !account
  ) {
    throw new Error(
      "Conta Mercado Livre não encontrada.",
    );
  }

  if (
    account.connection_status !==
      "connected" ||
    !account.seller_id
  ) {
    throw new Error(
      "A conta Mercado Livre não está conectada corretamente.",
    );
  }


  const validToken =
    await getValidMercadoLivreAccessToken(
      account.id,
    );


  /*
   * Consulta o primeiro pedido na ordenação
   * cronológica.
   */
  const [oldestSearch, newestSearch] = await Promise.all([
    searchSellerOrders({
      sellerId:
        account.seller_id,

      accessToken:
        validToken.accessToken,

      limit:
        1,

      offset:
        0,

      sort:
        "date_asc",
    }),


  /*
   * Consulta o primeiro pedido na ordenação
   * cronológica inversa.
   */
    searchSellerOrders({
      sellerId:
        account.seller_id,

      accessToken:
        validToken.accessToken,

      limit:
        1,

      offset:
        0,

      sort:
        "date_desc",
    }),
  ]);


  const oldestOrder =
    getOrderBoundary(
      oldestSearch.orders[0],
    );


  const newestOrder =
    getOrderBoundary(
      newestSearch.orders[0],
    );


  if (
    !oldestOrder ||
    !newestOrder
  ) {
    throw new Error(
      "Não foi possível determinar o intervalo histórico dos pedidos.",
    );
  }


  return {
    accountId:
      account.id,

    account:
      account.display_name,

    total:
      Math.max(
        oldestSearch.total,
        newestSearch.total,
      ),

    oldestOrder,

    newestOrder,

    tokenRefreshed:
      validToken.refreshed,
  };
}
