import {
  NextResponse,
  type NextRequest,
} from "next/server";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { getValidMercadoLivreAccessToken } from "@/integrations/mercado-livre/access-token";
import { MERCADO_LIVRE_URLS } from "@/integrations/mercado-livre/constants";
import { createAdminClient } from "@/lib/supabase/admin";

type AccountRow = {
  id: string;
  code: string;
  seller_id: string | null;
  connection_status: string;
};

type ScanPayload = {
  results?: unknown;
  scroll_id?: unknown;

  paging?: {
    total?: unknown;
    limit?: unknown;
  };
};

async function fetchScanPage({
  sellerId,
  accessToken,
  scrollId,
}: {
  sellerId: string;
  accessToken: string;
  scrollId?: string | null;
}) {
  const url =
    new URL(
      `${MERCADO_LIVRE_URLS.api}/users/${encodeURIComponent(
        sellerId,
      )}/items/search`,
    );

  url.searchParams.set(
    "search_type",
    "scan",
  );

  url.searchParams.set(
    "limit",
    "50",
  );

  if (scrollId) {
    url.searchParams.set(
      "scroll_id",
      scrollId,
    );
  }

  const response =
    await fetch(
      url,
      {
        headers: {
          Authorization:
            `Bearer ${accessToken}`,

          Accept:
            "application/json",
        },

        cache:
          "no-store",
      },
    );

  if (!response.ok) {
    const body =
      await response.text();

    throw new Error(
      `Scan Mercado Livre falhou. HTTP ${response.status}. ${body.slice(
        0,
        500,
      )}`,
    );
  }

  const payload =
    (await response.json()) as
      ScanPayload;

  const itemIds =
    Array.isArray(
      payload.results,
    )
      ? payload.results.filter(
          (
            value,
          ): value is string =>
            typeof value ===
              "string" &&
            value.length > 0,
        )
      : [];

  const returnedScrollId =
    typeof payload.scroll_id ===
      "string"
      ? payload.scroll_id
      : null;

  const total =
    typeof payload.paging
      ?.total === "number"
      ? payload.paging.total
      : null;

  return {
    itemIds,
    scrollId:
      returnedScrollId,
    total,
  };
}

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
    request.nextUrl
      .searchParams
      .get("account")
      ?? "speedbikers";

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
      data:
        | AccountRow
        | null;

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
    page: number;
    count: number;
    total: number | null;
    scrollIdReceived: boolean;
    scrollChanged: boolean | null;
    first5: string[];
    last5: string[];
    itemIds: string[];
  }> = [];

  let scrollId:
    | string
    | null = null;

  for (
    let page = 1;
    page <= 3;
    page += 1
  ) {
    const previousScrollId =
      scrollId;

    const result =
      await fetchScanPage({
        sellerId:
          account.seller_id,

        accessToken:
          token.accessToken,

        scrollId,
      });

    pages.push({
      page,

      count:
        result.itemIds.length,

      total:
        result.total,

      scrollIdReceived:
        Boolean(
          result.scrollId,
        ),

      scrollChanged:
        previousScrollId
          ? previousScrollId !==
            result.scrollId
          : null,

      first5:
        result.itemIds.slice(
          0,
          5,
        ),

      last5:
        result.itemIds.slice(
          -5,
        ),

      itemIds:
        result.itemIds,
    });

    scrollId =
      result.scrollId;

    if (
      result.itemIds.length ===
        0 ||
      !scrollId
    ) {
      break;
    }
  }

  const allIds =
    pages.flatMap(
      (page) =>
        page.itemIds,
    );

  const uniqueIds =
    new Set(
      allIds,
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
        pages:
          pages.length,

        returnedIds:
          allIds.length,

        uniqueIds:
          uniqueIds.size,

        duplicatedIds:
          allIds.length -
          uniqueIds.size,
      },

      pages:
        pages.map(
          ({
            itemIds: _,
            ...page
          }) => page,
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