import {
  timingSafeEqual,
} from "node:crypto";

import { NextResponse } from "next/server";

import { processNextListingsSyncBatch } from "@/features/ml-sync/process-listings-sync-worker";

import { syncRecentSbOrdersIfDue } from "@/features/ml-sync/sync-recent-orders";

import { processNextOrdersBackfillBatch } from "@/features/ml-sync/process-orders-backfill-worker";

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
  "orders_backfill"
) {
  const result =
    await processNextOrdersBackfillBatch();


  return NextResponse.json(
    result,
  );
}


    const result =
      await processNextListingsSyncBatch();


    return NextResponse.json(
      result,
    );
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