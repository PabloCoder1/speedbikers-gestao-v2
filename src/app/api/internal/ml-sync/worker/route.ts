import {
  timingSafeEqual,
} from "node:crypto";

import { NextResponse } from "next/server";

import { processNextListingsSyncBatch } from "@/features/ml-sync/process-listings-sync-worker";

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
      !isAuthorized(request)
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