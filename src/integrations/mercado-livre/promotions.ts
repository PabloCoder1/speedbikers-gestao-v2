import "server-only";

import { MERCADO_LIVRE_URLS } from "./constants";


const DEFAULT_TIMEOUT_MS = 15_000;


/*
 * Propositalmente genérico.
 *
 * Ainda não sabemos o formato exato retornado por cada
 * modalidade de promoção brasileira. Primeiro vemos o
 * payload real, depois tipamos.
 */
export type MercadoLivreItemPromotionsResponse =
  | Record<string, unknown>
  | Record<string, unknown>[];


function isJsonObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}


export async function getMercadoLivreItemPromotions({
  itemId,
  accessToken,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  itemId: string;
  accessToken: string;
  timeoutMs?: number;
}): Promise<MercadoLivreItemPromotionsResponse> {
  const normalizedItemId = itemId.trim();


  if (!normalizedItemId) {
    throw new Error(
      "Item Mercado Livre é obrigatório para consultar promoções.",
    );
  }


  if (!accessToken) {
    throw new Error(
      "Access token Mercado Livre é obrigatório para consultar promoções.",
    );
  }


  const controller = new AbortController();


  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);


  try {
    const url = new URL(
      `${MERCADO_LIVRE_URLS.api}/seller-promotions/items/${encodeURIComponent(
        normalizedItemId,
      )}`,
    );


    url.searchParams.set("app_version", "v2");


    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: controller.signal,
    });


    if (!response.ok) {
      const body = await response.text();


      throw new Error(
        `Falha ao consultar promoções de ${normalizedItemId}. HTTP ${
          response.status
        }. ${body.slice(0, 300)}`,
      );
    }


    const payload: unknown = await response.json();


    if (isJsonObject(payload)) {
      return payload;
    }


    if (
      Array.isArray(payload) &&
      payload.every(isJsonObject)
    ) {
      return payload;
    }


    throw new Error(
      `Resposta inválida ao consultar promoções de ${normalizedItemId}.`,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "AbortError"
    ) {
      throw new Error(
        `REQUEST_TIMEOUT: consulta de promoções de ${normalizedItemId} excedeu ${timeoutMs}ms.`,
      );
    }


    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
