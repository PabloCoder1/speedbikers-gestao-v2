import { lerTokenDeSessao } from "../../../lib/chamar-api";

interface ConnectResponse {
  authorizationUrl?: unknown;
}

interface ErrorResponse {
  error?: { message?: string };
}

/**
 * Chama o endpoint de início do OAuth na `api`, valida que a resposta 200
 * trouxe uma `authorizationUrl` utilizável e devolve erro legível em falha
 * de sessão, rede, HTTP ou payload inesperado (D-741).
 */
export async function iniciarConexaoOAuth(opcoes: {
  caminho: string;
  corpo?: Record<string, unknown>;
  mensagem503?: string;
}): Promise<{ ok: true; authorizationUrl: string } | { ok: false; mensagem: string }> {
  const sessao = await lerTokenDeSessao("Sua sessão expirou. Entre de novo.");

  if (!sessao.ok) {
    return sessao;
  }

  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "";

  let response: Response;

  try {
    response = await fetch(`${apiUrl}${opcoes.caminho}`, {
      method: "POST",
      headers: {
        ...(opcoes.corpo === undefined ? {} : { "content-type": "application/json" }),
        authorization: `Bearer ${sessao.token}`,
      },
      ...(opcoes.corpo === undefined ? {} : { body: JSON.stringify(opcoes.corpo) }),
    });
  } catch {
    return { ok: false, mensagem: "Não foi possível contatar o servidor. Tente novamente." };
  }

  if (!response.ok) {
    if (response.status === 503 && opcoes.mensagem503 !== undefined) {
      return { ok: false, mensagem: opcoes.mensagem503 };
    }

    const body = (await response.json().catch(() => null)) as ErrorResponse | null;

    return { ok: false, mensagem: body?.error?.message ?? "Não foi possível iniciar a conexão." };
  }

  const body = (await response.json().catch(() => null)) as ConnectResponse | null;

  if (typeof body?.authorizationUrl !== "string" || body.authorizationUrl === "") {
    return { ok: false, mensagem: "Não foi possível iniciar a conexão." };
  }

  return { ok: true, authorizationUrl: body.authorizationUrl };
}
