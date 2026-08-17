import { createServerClient } from "@supabase/ssr";
import {
  NextResponse,
  type NextRequest,
} from "next/server";

/*
 * Rotas que precisam responder sem sessão de usuário.
 *
 * /login:
 * precisa funcionar sem sessão.
 *
 * /api/internal/ml-sync/worker:
 * não utiliza sessão de usuário. Possui autenticação
 * própria através de SYNC_WORKER_SECRET.
 *
 * /api/mercado-livre/notifications:
 * webhook chamado pelo Mercado Livre, que nunca envia
 * cookie. Sem esta liberação o POST recebia redirect
 * para /login e a notificação nunca chegava ao handler.
 * O próprio handler limita o corpo a 64 KiB e valida
 * application_id, seller e resource antes de enfileirar.
 *
 * A comparação é por caminho exato, de propósito: liberar
 * um prefixo como /api/mercado-livre abriria também as
 * rotas administrativas vizinhas.
 */
const PUBLIC_EXACT_PATHS = new Set([
  "/api/internal/ml-sync/worker",
  "/api/mercado-livre/notifications",
]);

export function isPublicProxyRoute(
  pathname: string,
) {
  return (
    pathname.startsWith("/login") ||
    PUBLIC_EXACT_PATHS.has(pathname)
  );
}

export async function updateSession(
  request: NextRequest,
) {
  let supabaseResponse =
    NextResponse.next({
      request,
    });

  const supabase =
    createServerClient(
      process.env
        .NEXT_PUBLIC_SUPABASE_URL!,

      process.env
        .NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,

      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },

          setAll(
            cookiesToSet,
            headers,
          ) {
            cookiesToSet.forEach(
              ({
                name,
                value,
              }) => {
                request.cookies.set(
                  name,
                  value,
                );
              },
            );

            supabaseResponse =
              NextResponse.next({
                request,
              });

            cookiesToSet.forEach(
              ({
                name,
                value,
                options,
              }) => {
                supabaseResponse.cookies.set(
                  name,
                  value,
                  options,
                );
              },
            );

            Object.entries(
              headers,
            ).forEach(
              ([
                key,
                value,
              ]) => {
                supabaseResponse.headers.set(
                  key,
                  value,
                );
              },
            );
          },
        },
      },
    );

  const { data } =
    await supabase.auth.getClaims();

  const claims =
    data?.claims;

  const pathname =
    request.nextUrl.pathname;

  const isPublicRoute =
    isPublicProxyRoute(
      pathname,
    );

  if (
    !claims &&
    !isPublicRoute
  ) {
    const url =
      request.nextUrl.clone();

    url.pathname =
      "/login";

    url.search = "";

    return NextResponse.redirect(
      url,
    );
  }

  return supabaseResponse;
}