import {
  NextResponse,
  type NextRequest,
} from "next/server";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { checkOrdersHistoryWindow } from "@/features/ml-sync/check-orders-history-window";
import { createAdminClient } from "@/lib/supabase/admin";


function startOfDayUtc(
  date: string,
) {
  return `${date}T00:00:00.000Z`;
}


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


  const from =
    request.nextUrl
      .searchParams
      .get("from");


  const to =
    request.nextUrl
      .searchParams
      .get("to");


  if (
    accountCode !== "sb"
  ) {
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


  const datePattern =
    /^\d{4}-\d{2}-\d{2}$/;


  if (
    !from ||
    !to ||
    !datePattern.test(
      from,
    ) ||
    !datePattern.test(
      to,
    )
  ) {
    return NextResponse.json(
      {
        error:
          "invalid_date_range",

        example:
          "?account=sb&from=2025-08-10&to=2025-08-17",
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
      "sb",
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
    const result =
      await checkOrdersHistoryWindow({
        organizationId:
          access.organizationId,

        mlAccountId:
          account.id,

        dateFrom:
          startOfDayUtc(
            from,
          ),

        dateTo:
          startOfDayUtc(
            to,
          ),
      });


    return NextResponse.json({
      ok: true,

      ...result,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Erro desconhecido.";


    console.error(
      "Orders window check failed:",
      message,
    );


    return NextResponse.json(
      {
        error:
          "orders_window_check_failed",

        message,
      },
      {
        status: 500,
      },
    );
  }
}