import {
  NextResponse,
  type NextRequest,
} from "next/server";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { syncListingsPreview } from "@/features/ml-sync/sync-listings-preview";
import { createAdminClient } from "@/lib/supabase/admin";

type AccountRow = {
  id: string;
  code: string;
};

async function countListings(
  mlAccountId: string,
) {
  const admin =
    createAdminClient();

  const {
    count,
    error,
  } = await admin
    .from("ml_listings")
    .select(
      "id",
      {
        count: "exact",
        head: true,
      },
    )
    .eq(
      "ml_account_id",
      mlAccountId,
    );

  if (error) {
    throw new Error(
      "Não foi possível contar os anúncios.",
    );
  }

  return count ?? 0;
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
      "id, code",
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

  const offsets = [
    0,
    50,
    100,
  ];

  const before =
    await countListings(
      account.id,
    );

  const batches = [];

  for (
    const offset of offsets
  ) {
    const countBefore =
      await countListings(
        account.id,
      );

    const result =
      await syncListingsPreview({
        organizationId:
          access.organizationId,

        mlAccountId:
          account.id,

        offset,

        limit: 50,

        manageRunLifecycle:
          true,
      });

    const countAfter =
      await countListings(
        account.id,
      );

    batches.push({
      offset,

      sellerTotal:
        result.sellerTotal,

      pageItems:
        result.pageItems,

      importedListings:
        result.importedListings,

      countBefore,

      countAfter,

      realGrowth:
        countAfter -
        countBefore,
    });
  }

  const after =
    await countListings(
      account.id,
    );

  return NextResponse.json(
    {
      account:
        account.code,

      before,

      after,

      totalRealGrowth:
        after - before,

      batches,
    },
    {
      headers: {
        "Cache-Control":
          "no-store",
      },
    },
  );
}