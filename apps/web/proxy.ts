import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { gerarNonce, montarCsp } from "./lib/csp";

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
  /*
    A CSP COM NONCE (D-331). Um nonce novo por requisição, na política da
    RESPOSTA (é ela que o navegador aplica) e na da REQUISIÇÃO (é dela que o Next
    extrai o nonce, durante a renderização, e o põe nos próprios scripts).
  */
  const nonce = gerarNonce();
  const csp = montarCsp({
    nonce,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    apiUrl: process.env.NEXT_PUBLIC_API_URL,
    dev: process.env.NODE_ENV === "development",
  });

  /*
    Os cabeçalhos da requisição que segue para a página, montados A CADA vez a
    partir de `request.headers`. A ordem importa: `setAll` escreve o cookie de
    sessão renovado em `request.cookies` e recria a resposta — uma cópia feita
    antes disso carregaria o cookie velho, e a página renderizaria sem a sessão
    que acabou de ser renovada.
  */
  function seguir(): NextResponse {
    const cabecalhos = new Headers(request.headers);

    cabecalhos.set("x-nonce", nonce);
    cabecalhos.set("content-security-policy", csp);

    return NextResponse.next({ request: { headers: cabecalhos } });
  }

  let response = seguir();

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

          response = seguir();

          for (const { name, value, options } of toSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  /*
    QUEM É, CONFERIDO PELA ASSINATURA (D-532). `getClaims` confere a assinatura
    e a validade do token com a chave pública do projeto (JWKS, guardada em
    memória por 10 minutos), sem ir ao servidor de Auth. Era `getUser`, que
    revalidava o token lá a CADA requisição: a carga, a navegação e cada uma
    das ~45 pré-buscas de uma visita (os links da barra lateral) esperavam uma
    ida ao Auth antes de renderizar. Medido no build local a 150 ms por
    chamada: ~50 chamadas ao Auth por visita viraram 1, e a troca de tela pela
    barra caiu de ~615 para ~430 ms.

    `getSession` continua não servindo: devolve o que está no cookie sem
    conferir, e o navegador pode tê-lo alterado. Token adulterado ou vencido
    falha na assinatura e cai no login; vencido com refresh válido é renovado
    aqui, e o cookie novo segue (`setAll`).

    O que muda: uma sessão encerrada em OUTRO aparelho só para de abrir telas
    quando o token dela vence (1 h, `jwt_expiry`) — o mesmo prazo em que o
    PostgREST já a aceita para ler dado. O `Shell` segue chamando `getUser`
    na carga inteira da tela. Com chave simétrica (HS256), o `getClaims` chama
    o próprio `getUser`, e nada muda.
  */
  const { data } = await supabase.auth.getClaims();

  const { pathname } = request.nextUrl;

  const isPublic =
    PUBLIC_EXACT.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));

  if ((data?.claims.sub ?? null) === null && !isPublic) {
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

  response.headers.set("Content-Security-Policy", csp);

  return response;
}

export const config = {
  // Estaticos nao passam pelo proxy: rodar a verificacao neles gastaria uma
  // chamada de Auth por arquivo. `brand/` e `icon.png` sao a logo e o icone da
  // aba (D-355): sem esta exclusao a tela de LOGIN, que e publica, recebia um
  // 307 para /login no lugar da imagem.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.png|brand/).*)"],
};
