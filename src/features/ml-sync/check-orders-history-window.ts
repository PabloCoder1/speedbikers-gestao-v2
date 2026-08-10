import "server-only";

import { getValidMercadoLivreAccessToken } from "../../integrations/mercado-livre/access-token";
import {
  searchSellerOrders,
  type MercadoLivreOrder,
} from "../../integrations/mercado-livre/orders";
import { createAdminClient } from "../../lib/supabase/admin";


function getOrderSummary(
  order:
    MercadoLivreOrder |
    undefined,
) {
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


  return {
    id:
      String(rawId),

    dateCreated:
      rawDate,
  };
}


export async function checkOrdersHistoryWindow({
  organizationId,
  mlAccountId,
  dateFrom,
  dateTo,
}: {
  organizationId: string;
  mlAccountId: string;
  dateFrom: string;
  dateTo: string;
}) {
  const admin =
    createAdminClient();


  type MlAccountRow = {
    id: string;
    organization_id: string;
    code: string;
    seller_id: string | null;
    connection_status: string;
  };

  const {
    data: account,
    error: accountError,
  } = await admin
    .from("ml_accounts")
    .select(
      [
        "id",
        "organization_id",
        "code",
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
    .maybeSingle<MlAccountRow>();


  if (
    accountError ||
    !account
  ) {
    throw new Error(
      "Conta Mercado Livre não encontrada.",
    );
  }


  if (account.code !== "sb") {
    throw new Error(
      "O diagnóstico histórico está habilitado somente para a SB.",
    );
  }


  if (
    account.connection_status !==
      "connected" ||
    !account.seller_id
  ) {
    throw new Error(
      "A conta SB não está conectada.",
    );
  }


  const validToken =
    await getValidMercadoLivreAccessToken(
      account.id,
    );


  const oldest =
    await searchSellerOrders({
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

      dateCreatedFrom:
        dateFrom,

      dateCreatedTo:
        dateTo,
    });


  const newest =
    await searchSellerOrders({
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

      dateCreatedFrom:
        dateFrom,

      dateCreatedTo:
        dateTo,
    });


  return {
    requestedRange: {
      from:
        dateFrom,

      to:
        dateTo,
    },

    total:
      Math.max(
        oldest.total,
        newest.total,
      ),

    oldestOrder:
      getOrderSummary(
        oldest.orders[0],
      ),

    newestOrder:
      getOrderSummary(
        newest.orders[0],
      ),

    tokenRefreshed:
      validToken.refreshed,
  };
}