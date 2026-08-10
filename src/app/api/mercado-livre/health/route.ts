import {
  NextResponse,
  type NextRequest,
} from "next/server";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import {
  isMercadoLivreAppCode,
} from "@/integrations/mercado-livre/config";
import { getValidMercadoLivreAccessToken } from "@/integrations/mercado-livre/access-token";
import { getMercadoLivreCurrentUser } from "@/integrations/mercado-livre/users";
import { createAdminClient } from "@/lib/supabase/admin";

type MercadoLivreAccountRow = {
  id: string;
  code: string;
  display_name: string | null;
  seller_id: string | null;
  connection_status: string;
};

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
    request.nextUrl.searchParams.get(
      "account",
    );

  if (
    !accountCode ||
    !isMercadoLivreAppCode(
      accountCode,
    )
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

  const admin =
    createAdminClient();

  const {
    data: account,
    error: accountError,
  } = await admin
    .from("ml_accounts")
    .select(
      [
        "id",
        "code",
        "display_name",
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
    .maybeSingle<MercadoLivreAccountRow>();

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

  const typedAccount =
    account as MercadoLivreAccountRow;

  if (
    typedAccount.connection_status !==
    "connected"
  ) {
    return NextResponse.json(
      {
        error:
          "account_not_connected",

        status:
          typedAccount.connection_status,
      },
      {
        status: 409,
      },
    );
  }

  try {
    const validToken =
      await getValidMercadoLivreAccessToken(
        typedAccount.id,
      );

    const seller =
      await getMercadoLivreCurrentUser(
        validToken.accessToken,
      );

    if (
      typedAccount.seller_id !==
      seller.id
    ) {
      return NextResponse.json(
        {
          error:
            "seller_mismatch",
        },
        {
          status: 409,
        },
      );
    }

    return NextResponse.json({
      ok: true,

      account:
        typedAccount.display_name,

      connectionStatus:
        typedAccount.connection_status,

      sellerNickname:
        seller.nickname,

      siteId:
        seller.siteId,

      tokenExpiresAt:
        validToken.expiresAt,

      refreshed:
        validToken.refreshed,
    });
  } catch (error) {
    console.error(
      "Mercado Livre health check failed:",
      error instanceof Error
        ? error.message
        : "unknown error",
    );

    return NextResponse.json(
      {
        error:
          "mercado_livre_health_failed",
      },
      {
        status: 500,
      },
    );
  }
}
