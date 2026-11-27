import { explicar404 } from "./api-desatualizada";
import { createClient } from "./supabase/browser";

/**
 * POST autenticado à `api`, com as mensagens de erro que a casa já aprendeu
 * (D-298, D-300, D-301) num lugar só (D-354).
 *
 * O convite e a reemissão de link têm cada um a sua cópia desta sequência;
 * a suspensão seria a terceira, e a terceira cópia é onde esta casa extrai.
 * As duas antigas continuam como estão — migrá-las é mudança sem pedido.
 */

export type RespostaDaApi<T> = { ok: true; corpo: T } | { ok: false; mensagem: string };

/**
 * Lê o access token da sessão do navegador sem deixar falhas do cliente Auth
 * escaparem sem tratamento para travar botões/formulários em estado ocupado.
 */
export async function lerTokenDeSessao(
  mensagemExpirada = "Sessão expirada — atualize a página e entre de novo.",
): Promise<{ ok: true; token: string } | { ok: false; mensagem: string }> {
  try {
    const { data } = await createClient().auth.getSession();
    const token = data.session?.access_token;

    if (token === undefined) {
      return { ok: false, mensagem: mensagemExpirada };
    }

    return { ok: true, token };
  } catch {
    return { ok: false, mensagem: "Não foi possível ler sua sessão. Entre de novo." };
  }
}

/**
 * Valida a resposta JSON 200 OK de `/v1/copilot/query` para ações narrativas
 * (`narrate_action` e `narrate_sku_diagnosis`), recusando HTML ou payload
 * malformado de proxy/CDN.
 */
export function extrairNarrativaDoCopiloto(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("data" in payload)) {
    return null;
  }

  const data = (payload as { data?: unknown }).data;

  if (typeof data !== "object" || data === null || !("narrativa" in data)) {
    return null;
  }

  const narrativa = (data as { narrativa?: unknown }).narrativa;

  return typeof narrativa === "string" && narrativa.trim().length > 0 ? narrativa : null;
}

/**
 * Valida a resposta JSON 200 OK das rotas `/v1/listings/relist*`, garantindo
 * que o enfileiramento veio da API e não de uma página HTML intermediária.
 */
export function respostaDeRepublicacaoValida(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { status?: unknown }).status === "queued"
  );
}

/**
 * POST autenticado para confirmar a aplicação de lote ou NF-e,
 * recuperando erro de sessão, rede, HTTP ou corpo 200 não confirmado.
 */
export async function confirmarAplicacaoNaApi(
  caminho: string,
  corpo?: { markAbsent: boolean },
): Promise<{ ok: true } | { ok: false; mensagem: string }> {
  const sessao = await lerTokenDeSessao("Sua sessão expirou. Entre de novo.");

  if (!sessao.ok) {
    return sessao;
  }

  try {
    const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? ""}${caminho}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessao.token}`,
        ...(corpo === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
    });

    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const message =
        typeof payload === "object" && payload !== null && "error" in payload
          ? (payload as { error?: { message?: string } }).error?.message
          : undefined;

      return { ok: false, mensagem: message ?? "Não foi possível confirmar a aplicação." };
    }

    if (
      typeof payload !== "object" ||
      payload === null ||
      (payload as { queued?: unknown }).queued !== true
    ) {
      return {
        ok: false,
        mensagem: "A API respondeu em formato inesperado. Confira se a aplicação foi iniciada.",
      };
    }

    return { ok: true };
  } catch {
    return { ok: false, mensagem: "Não foi possível falar com o servidor. Tente de novo." };
  }
}

export async function chamarApi<T>(caminho: string, corpo: unknown): Promise<RespostaDaApi<T>> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "";

  if (apiUrl === "") {
    return {
      ok: false,
      mensagem:
        "Esta instalação não sabe o endereço da API (NEXT_PUBLIC_API_URL). Esta ação é escrita privilegiada e não acontece sem ela.",
    };
  }

  const sessao = await lerTokenDeSessao();

  if (!sessao.ok) {
    return sessao;
  }

  try {
    const response = await fetch(`${apiUrl}${caminho}`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessao.token}`, "content-type": "application/json" },
      body: JSON.stringify(corpo),
    });

    const lido = (await response.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;

    if (!response.ok) {
      const doServidor = lido?.error?.message;

      if (doServidor !== undefined) return { ok: false, mensagem: doServidor };

      // 404 SEM corpo é a API no ar mais velha que a tela (D-301), não
      // "pessoa não encontrada" — essa chega com mensagem.
      if (response.status === 404) return { ok: false, mensagem: await explicar404(apiUrl) };

      return { ok: false, mensagem: `${apiUrl} não respondeu como a API (HTTP ${String(response.status)}).` };
    }

    if (lido === null) {
      return { ok: false, mensagem: "A API respondeu sem corpo." };
    }

    return { ok: true, corpo: lido };
  } catch {
    return { ok: false, mensagem: `Falha de conexão com a API em ${apiUrl}.` };
  }
}
