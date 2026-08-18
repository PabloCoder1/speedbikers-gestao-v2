import "server-only";

import { MERCADO_LIVRE_URLS } from "./constants";
import {
  classifyOrderFetchFailure,
  MercadoLivreOrderRequestError,
  parseRetryAfter,
} from "./order-error-classification";

export { MercadoLivreOrderRequestError };


export type MercadoLivreOrder =
  Record<string, unknown>;


function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}


export type MercadoLivreOrderSort =
  | "date_desc"
  | "date_asc";


const ORDERS_REQUEST_TIMEOUT_MS =
  15_000;


type OrdersSearchResponse = {
  results?: unknown;

  paging?: {
    total?: unknown;
    offset?: unknown;
    limit?: unknown;
  };

  sort?: unknown;

  available_sorts?: unknown;

  filters?: unknown;

  available_filters?: unknown;
};


export type SearchSellerOrdersParams = {
  sellerId: string;

  accessToken: string;

  limit?: number;

  offset?: number;

  sort?: MercadoLivreOrderSort;

  dateCreatedFrom?: string | null;

  dateCreatedTo?: string | null;
};


function assertValidIsoDate(
  value: string,
  fieldName: string,
) {
  const timestamp =
    Date.parse(value);


  if (
    Number.isNaN(
      timestamp,
    )
  ) {
    throw new Error(
      `${fieldName} possui uma data inválida.`,
    );
  }
}


export async function searchSellerOrders({
  sellerId,
  accessToken,
  limit = 50,
  offset = 0,
  sort = "date_desc",
  dateCreatedFrom = null,
  dateCreatedTo = null,
}: SearchSellerOrdersParams) {
  if (
    limit < 1 ||
    limit > 50
  ) {
    throw new Error(
      "O limite de pedidos deve ficar entre 1 e 50.",
    );
  }


  if (offset < 0) {
    throw new Error(
      "O offset de pedidos não pode ser negativo.",
    );
  }


  if (dateCreatedFrom) {
    assertValidIsoDate(
      dateCreatedFrom,
      "dateCreatedFrom",
    );
  }


  if (dateCreatedTo) {
    assertValidIsoDate(
      dateCreatedTo,
      "dateCreatedTo",
    );
  }


  if (
    dateCreatedFrom &&
    dateCreatedTo &&
    Date.parse(
      dateCreatedFrom,
    ) >=
      Date.parse(
        dateCreatedTo,
      )
  ) {
    throw new Error(
      "A data inicial deve ser anterior à data final.",
    );
  }


  const url =
    new URL(
      `${MERCADO_LIVRE_URLS.api}/orders/search`,
    );


  url.searchParams.set(
    "seller",
    sellerId,
  );


  url.searchParams.set(
    "sort",
    sort,
  );


  url.searchParams.set(
    "limit",
    String(limit),
  );


  url.searchParams.set(
    "offset",
    String(offset),
  );


  if (dateCreatedFrom) {
    url.searchParams.set(
      "order.date_created.from",
      dateCreatedFrom,
    );
  }


  if (dateCreatedTo) {
    url.searchParams.set(
      "order.date_created.to",
      dateCreatedTo,
    );
  }


  const controller =
    new AbortController();


  const timeout =
    setTimeout(
      () => {
        controller.abort();
      },
      ORDERS_REQUEST_TIMEOUT_MS,
    );


  let response:
    Response;


  let payload:
    | OrdersSearchResponse
    | null = null;


  try {
    response =
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

          signal:
            controller.signal,
        },
      );


    try {
      payload =
        (await response.json()) as
          OrdersSearchResponse;
    } catch {
      payload =
        null;
    }
  } catch (error) {
    const isAbort =
      error instanceof Error &&
      error.name ===
        "AbortError";


    if (isAbort) {
      throw new Error(
        `Falha ao consultar pedidos do seller. REQUEST_TIMEOUT após ${ORDERS_REQUEST_TIMEOUT_MS}ms.`,
      );
    }


    throw error;
  } finally {
    clearTimeout(
      timeout,
    );
  }


  if (
    !response.ok ||
    !payload
  ) {
    throw new Error(
      `Falha ao consultar pedidos do seller. HTTP ${response.status}.`,
    );
  }


  const results =
    Array.isArray(
      payload.results,
    )
      ? payload.results.filter(
          (
            value,
          ): value is MercadoLivreOrder =>
            Boolean(
              value &&
              typeof value ===
                "object" &&
              !Array.isArray(
                value,
              ),
            ),
        )
      : [];


  const total =
    typeof payload.paging
      ?.total === "number"
      ? payload.paging.total
      : results.length;


  return {
    orders:
      results,

    total,

    paging: {
      offset:
        typeof payload.paging
          ?.offset === "number"
          ? payload.paging.offset
          : offset,

      limit:
        typeof payload.paging
          ?.limit === "number"
          ? payload.paging.limit
          : limit,
    },

    filters:
      Array.isArray(
        payload.filters,
      )
        ? payload.filters
        : [],

    availableFilters:
      Array.isArray(
        payload.available_filters,
      )
        ? payload.available_filters
        : [],
  };
}


export type GetSellerOrderParams = {
  orderId: string;

  accessToken: string;

  timeoutMs?: number;
};


/*
 * GET /orders/{id} — the single-order fetch used by the orders_v2
 * refresh path (process-order-refresh-job.ts). searchSellerOrders
 * above stays list-only; nothing about it needed to change.
 */
export async function getSellerOrder({
  orderId,
  accessToken,
  timeoutMs = ORDERS_REQUEST_TIMEOUT_MS,
}: GetSellerOrderParams): Promise<{
  order: MercadoLivreOrder;
  raw: unknown;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;

  try {
    response = await fetch(
      `${MERCADO_LIVRE_URLS.api}/orders/${encodeURIComponent(orderId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
        cache: "no-store",
        signal: controller.signal,
      },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new MercadoLivreOrderRequestError(
        `Falha ao consultar o pedido ${orderId}. REQUEST_TIMEOUT após ${timeoutMs}ms.`,
        null,
        "timeout",
        error.message,
        true,
        false,
        null,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));

  const body = await response.text();
  let payload: unknown = null;
  try {
    payload = body ? JSON.parse(body) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const errorPayload = isObject(payload) ? payload : {};
    const responseCode =
      readString(errorPayload.error) ?? readString(errorPayload.code);
    const responseMessage =
      readString(errorPayload.message) ?? (body.slice(0, 300) || null);

    const classification = classifyOrderFetchFailure(response.status);

    throw new MercadoLivreOrderRequestError(
      `ORDER_HTTP_${response.status}:${responseCode ?? "unknown"}`,
      response.status,
      responseCode,
      responseMessage,
      classification.retryable,
      classification.notFound,
      retryAfterSeconds,
    );
  }

  if (!isObject(payload)) {
    throw new MercadoLivreOrderRequestError(
      "ORDER_INVALID_RESPONSE",
      response.status,
      null,
      null,
      false,
      false,
      null,
    );
  }

  return {
    order: payload,
    raw: payload,
  };
}