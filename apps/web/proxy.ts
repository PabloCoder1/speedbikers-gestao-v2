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
 * `/` e o painel de progresso do projeto: conteudo estatico, nenhum dado do
 * negocio. Exigir login nele so esconderia a pagina de quem acompanha a obra.
 * Por ser prefixo de tudo, ele entra na lista de EXATOS, nunca na de prefixos.
 */
const PUBLIC_EXACT = new Set(["/"]);
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

    login.pathname = "/login";
    login.searchParams.set("next", pathname);

    return NextResponse.redirect(login);
  }

  return response;
}

export const config = {
  // Estaticos do Next nao passam pelo proxy: rodar a verificacao neles
  // gastaria uma chamada de Auth por arquivo.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
