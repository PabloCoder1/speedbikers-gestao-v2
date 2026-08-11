import {
  NextResponse,
  type NextRequest,
} from "next/server";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { getOrdersHistoryRange } from "@/features/ml-sync/get-orders-history-range";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: NextRequest,
) {
  const access =
    await getCurrentAccess();

  if (!access) {
    return NextResponse.json(
      {
        error:
          "not_authenticated",
      },
      {
        status: 401,
      },
    );
  }

  if (
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
      .get("account");

  if (!accountCode) {
    return NextResponse.json(
      {
        error:
          "invalid_account",
      },
      {
        status: 400,
      },
    );
  }

  const admin =
    createAdminClient();

  const {
    data: account,
    error: accountError,
  } = await admin
    .from("ml_accounts")
    .select("id")
    .eq(
      "organization_id",
      access.organizationId,
    )
    .eq(
      "code",
      accountCode,
    )
    .maybeSingle();

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

  try {
    const range =
      await getOrdersHistoryRange({
        organizationId:
          access.organizationId,

        mlAccountId:
          account.id,
      });

    return NextResponse.json({
      ok: true,

      account:
        range.account,

      total:
        range.total,

      oldestOrder:
        range.oldestOrder,

      newestOrder:
        range.newestOrder,

      tokenRefreshed:
        range.tokenRefreshed,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Erro desconhecido.";

    console.error(
      "Orders history range failed:",
      message,
    );

    return NextResponse.json(
      {
        error:
          "history_range_failed",

        message,
      },
      {
        status: 500,
      },
    );
  }
}