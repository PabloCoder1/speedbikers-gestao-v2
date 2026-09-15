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

export async function chamarApi<T>(caminho: string, corpo: unknown): Promise<RespostaDaApi<T>> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "";

  if (apiUrl === "") {
    return {
      ok: false,
      mensagem:
        "Esta instalação não sabe o endereço da API (NEXT_PUBLIC_API_URL). Esta ação é escrita privilegiada e não acontece sem ela.",
    };
  }

  const { data } = await createClient().auth.getSession();
  const token = data.session?.access_token;

  if (token === undefined) {
    return { ok: false, mensagem: "Sessão expirada — atualize a página e entre de novo." };
  }

  try {
    const response = await fetch(`${apiUrl}${caminho}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
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
