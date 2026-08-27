import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Renovação de sessão e proteção de rota.
 *
 * ATENÇÃO ao nome do arquivo: no Next.js 16 `middleware.ts` foi DEPRECIADO e
 * renomeado para `proxy.ts`, com o export chamado `proxy`. Um arquivo
 * `middleware.ts` aqui simplesmente não roda — e falha em silêncio, deixando
 * toda rota desprotegida.
 */

/**
 * Rotas que dispensam sessao.
 *
 * **Vazia desde 2026-08-27 (D-105).** `/` morava aqui enquanto era o painel
 * de progresso da construcao — "conteudo estatico, nenhum dado do negocio",
 * dizia a justificativa original, e ela estava certa. A Home passou a ser a
 * Visao Geral orientada a atencao, que le `actions`, `support_cases` e
 * `notification_recipients`: a condicao que tornava a rota publica deixou de
 * existir junto com a pagina estatica, entao a excecao saiu com ela.
 *
 * Sem sessao, `/` agora cai no mesmo redirect de todas as outras telas —
 * `/login?next=%2F`. O mecanismo fica no lugar: se algum dia nascer uma rota
 * exata publica, ela entra aqui, NUNCA em `PUBLIC_PREFIXES` (barra e prefixo
 * de tudo, e liberaria o sistema inteiro).
 */
const PUBLIC_EXACT = new Set<string>();
const PUBLIC_PREFIXES = ["/login", "/auth"];

export async function proxy(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          for (const { name, value } of toSet) {
            request.cookies.set(name, value);
          }

          response = NextResponse.next({ request });

          for (const { name, value, options } of toSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // `getUser` e não `getSession`: só o primeiro revalida o token contra o
  // servidor de Auth. `getSession` devolve o que está no cookie, que o
  // navegador pode ter alterado.
  const { data } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  const isPublic =
    PUBLIC_EXACT.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));

  if (data.user === null && !isPublic) {
    const login = request.nextUrl.clone();

    // `next` precisa levar a QUERY STRING junto, não só o caminho (achado em
    // 2026-08-25, D-090). Toda tela filtrada guarda o filtro em query param —
    // `/vendas?days=90&account=x`, `/atendimento?status=RESOLVIDO`, e os
    // presets de "Filtros salvos" (D-062) são literalmente isso. Sem a query,
    // abrir um link filtrado sem sessão levava a pessoa para a tela SEM o
    // filtro depois de entrar, sem nenhum sinal de que algo se perdeu.
    const target = `${pathname}${request.nextUrl.search}`;

    login.pathname = "/login";
    // `clone()` traz os params da tela de origem junto; zerar antes evita que
    // eles apareçam soltos na URL de login, misturados com `next`.
    login.search = "";
    login.searchParams.set("next", target);

    return NextResponse.redirect(login);
  }

  return response;
}

export const config = {
  // Estaticos do Next nao passam pelo proxy: rodar a verificacao neles
  // gastaria uma chamada de Auth por arquivo.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
