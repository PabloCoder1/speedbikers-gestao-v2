import {
  timingSafeEqual,
} from "node:crypto";

import { NextResponse } from "next/server";

import { processNextListingsSyncBatch } from "@/features/ml-sync/process-listings-sync-worker";
import { processFulfillmentStockBackfillBurst } from "@/features/ml-sync/process-fulfillment-stock-backfill";
import { processNextFulfillmentRefreshJob } from "@/features/ml-sync/process-fulfillment-refresh-job";
import { processOfferPricesBackfillBurst } from "@/features/ml-sync/process-offer-prices-backfill";
import { processNextOfferRefreshJob } from "@/features/ml-sync/process-offer-refresh-job";
import { processNextOperationalAlertJob } from "@/features/stock/process-operational-alert-job";
import { processUpsellerImportBurst } from "@/features/upseller/process-import-worker";

import { syncRecentSbOrdersIfDue } from "@/features/ml-sync/sync-recent-orders";

import { processOrdersBackfillBurst } from "@/features/ml-sync/process-orders-backfill-burst";

export const maxDuration = 60;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";


function isAuthorized(
  request: Request,
) {
  const expected =
    process.env
      .SYNC_WORKER_SECRET;

  if (!expected) {
    throw new Error(
      "SYNC_WORKER_SECRET não está configurado.",
    );
  }

  const authorization =
    request.headers.get(
      "authorization",
    );

  if (!authorization) {
    return false;
  }

  const prefix =
    "Bearer ";

  if (
    !authorization.startsWith(
      prefix,
    )
  ) {
    return false;
  }

  const received =
    authorization.slice(
      prefix.length,
    );

  const expectedBuffer =
    Buffer.from(expected);

  const receivedBuffer =
    Buffer.from(received);

  if (
    expectedBuffer.length !==
    receivedBuffer.length
  ) {
    return false;
  }

  return timingSafeEqual(
    expectedBuffer,
    receivedBuffer,
  );
}

export async function POST(
  request: Request,
) {
  try {
    if (
      !isAuthorized(
        request,
      )
    ) {
      return NextResponse.json(
        {
          error:
            "not_authorized",
        },
        {
          status: 401,
        },
      );
    }


    let payload:
      Record<string, unknown> =
      {};


    try {
      const body =
        await request.json();

      if (
        body &&
        typeof body ===
          "object" &&
        !Array.isArray(body)
      ) {
        payload =
          body as
            Record<
              string,
              unknown
            >;
      }
    } catch {
      payload = {};
    }


    if (
      payload.task ===
      "upseller_import"
    ) {
      return NextResponse.json(
        await processUpsellerImportBurst(),
      );
    }


    if (
      payload.task ===
      "fulfillment_stock_backfill"
    ) {
      return NextResponse.json(
        await processFulfillmentStockBackfillBurst(),
      );
    }


    if (
      payload.task ===
      "fulfillment_stock_refresh"
    ) {
      return NextResponse.json(
        await processNextFulfillmentRefreshJob(),
      );
    }


    if (
      payload.task ===
      "operational_alerts"
    ) {
      return NextResponse.json(
        await processNextOperationalAlertJob(),
      );
    }


    if (
  payload.task ===
  "orders_backfill"
) {
  const result =
    await processOrdersBackfillBurst();


  return NextResponse.json(
    result,
  );
}


    if (
  payload.task ===
  "orders_recent"
) {
  const result =
    await syncRecentSbOrdersIfDue();


  return NextResponse.json(
    result,
  );
}


    if (
      payload.task ===
      "offer_prices_backfill"
    ) {
      const result =
        await processOfferPricesBackfillBurst();

      return NextResponse.json(
        result,
      );
    }


    if (
      payload.task ===
      "offer_refresh"
    ) {
      const result =
        await processNextOfferRefreshJob();

      return NextResponse.json(
        result,
      );
    }


    const listingsResult =
      await processNextListingsSyncBatch();


    return NextResponse.json({
      task:
        "listings_full",

      ...listingsResult,
    });
  } catch (error) {
    console.error(
      "ML sync worker failed:",
      error instanceof Error
        ? error.message
        : "unknown error",
    );


    return NextResponse.json(
      {
        error:
          "worker_failed",
      },
      {
        status: 500,
      },
    );
  }
}
