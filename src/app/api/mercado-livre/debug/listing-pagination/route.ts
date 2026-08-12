import {
  NextResponse,
  type NextRequest,
} from "next/server";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { getValidMercadoLivreAccessToken } from "@/integrations/mercado-livre/access-token";
import { searchSellerItemIds } from "@/integrations/mercado-livre/items";
import { createAdminClient } from "@/lib/supabase/admin";

type AccountRow = {
  id: string;
  code: string;
  seller_id: string | null;
  connection_status: string;
};

/*
 * Somente offsets dentro da janela
 * suportada pela paginação tradicional.
 *
 * 950 + 50 = 1000.
 */
const OFFSETS = [
  0,
  50,
  100,
  150,
  200,
  500,
  900,
  950,
];

export async function GET(
  request: NextRequest,
) {
  const access =
    await getCurrentAccess();

  if (
    !access ||
    access.role !== "admin"
  ) {
    return NextResponse.json(
      {
        error:
          "not_authorized",
      },
      {
        status: 403,
      },
    );
  }

  const accountCode =
    request.nextUrl.searchParams.get(
      "account",
    ) ?? "speedbikers";

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
        "code",
        "seller_id",
        "connection_status",
      ].join(","),
    )
    .eq(
      "organization_id",
      access.organizationId,
    )
    .eq(
      "code",
      accountCode,
    )
    .maybeSingle()) as {
    data: AccountRow | null;
    error: unknown;
  };

  if (
    accountError ||
    !account
  ) {
    return NextResponse.json(
      {
        error:
          "account_not_found",
      },
      {
        status: 404,
      },
    );
  }

  if (
    account.connection_status !==
      "connected" ||
    !account.seller_id
  ) {
    return NextResponse.json(
      {
        error:
          "account_not_connected",
      },
      {
        status: 400,
      },
    );
  }

  const token =
    await getValidMercadoLivreAccessToken(
      account.id,
    );

  const pages: Array<{
    requestedOffset: number;
    sellerTotal?: number;
    count?: number;
    itemIds?: string[];
    error?: string;
  }> = [];

  for (
    const offset of OFFSETS
  ) {
    try {
      const result =
        await searchSellerItemIds({
          sellerId:
            account.seller_id,

          accessToken:
            token.accessToken,

          offset,

          limit: 50,
        });

      pages.push({
        requestedOffset:
          offset,

        sellerTotal:
          result.total,

        count:
          result.itemIds.length,

        itemIds:
          result.itemIds,
      });
    } catch (error) {
      pages.push({
        requestedOffset:
          offset,

        error:
          error instanceof Error
            ? error.message
            : "Erro desconhecido.",
      });
    }
  }

  const successfulIds =
    pages.flatMap(
      (page) =>
        page.itemIds ?? [],
    );

  const uniqueIds =
    Array.from(
      new Set(
        successfulIds,
      ),
    );

  return NextResponse.json(
    {
      account: {
        code:
          account.code,

        sellerId:
          account.seller_id,
      },

      summary: {
        requestedPages:
          OFFSETS.length,

        returnedIds:
          successfulIds.length,

        uniqueIds:
          uniqueIds.length,

        duplicatedIds:
          successfulIds.length -
          uniqueIds.length,
      },

      pages:
        pages.map(
          (page) => ({
            requestedOffset:
              page.requestedOffset,

            sellerTotal:
              page.sellerTotal,

            count:
              page.count,

            error:
              page.error,

            first5:
              page.itemIds?.slice(
                0,
                5,
              ),

            last5:
              page.itemIds?.slice(
                -5,
              ),
          }),
        ),
    },
    {
      headers: {
        "Cache-Control":
          "no-store",
      },
    },
  );
}