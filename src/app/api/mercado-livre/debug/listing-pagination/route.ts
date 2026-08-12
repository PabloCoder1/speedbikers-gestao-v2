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

const OFFSETS = [
  0,
  50,
  100,
  500,
  1000,
  1050,
  1300,
  1350,
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

  const pages = [];

  for (
    const offset of OFFSETS
  ) {
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

      first10:
        result.itemIds.slice(
          0,
          10,
        ),

      last10:
        result.itemIds.slice(
          -10,
        ),
    });
  }

  const baseIds =
    new Set(
      pages[0]?.first10 ??
        [],
    );

  const comparison =
    pages.map(
      (page) => ({
        requestedOffset:
          page.requestedOffset,

        count:
          page.count,

        first10SameAsPageZero:
          page.first10.filter(
            (id) =>
              baseIds.has(id),
          ).length,

        first10:
          page.first10,
      }),
    );

  return NextResponse.json(
    {
      account: {
        code:
          account.code,

        sellerId:
          account.seller_id,
      },

      pages,

      comparison,
    },
    {
      headers: {
        "Cache-Control":
          "no-store",
      },
    },
  );
}