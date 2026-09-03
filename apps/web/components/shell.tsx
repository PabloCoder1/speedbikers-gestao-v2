import Link from "next/link";
import type { ReactNode } from "react";

import { createClient } from "../lib/supabase/server";
import { CommandPalette } from "./command-palette";
import type { NotificationPreferenceRule } from "../lib/notification-preferences";
import { NotificationToasts } from "./notification-toasts";
import { SidebarNav } from "./nav";
import { currentMembership } from "../lib/membership";

/**
 * Moldura das telas autenticadas: sidebar escura à esquerda, topbar e área
 * central (D3 da frente visual).
 *
 * O papel é lido do banco, não do token. Um JWT pode ser antigo — alguém
 * rebaixado de ADMIN para VISUALIZADOR continuaria vendo o menu de ADMIN até o
 * token expirar. Ler de `organization_members` custa uma consulta e elimina a
 * janela.
 *
 * **A navegação saiu do topo.** Até D2 eram 29 links em cinco dropdowns
 * horizontais; o brief do usuário (`speed-bikers-design.md`, seção 7 "ESTRUTURA
 * GLOBAL") pede "SIDEBAR VERTICAL ESQUERDA + TOP BAR + ÁREA CENTRAL" e fecha
 * com "Não usar dezenas de links horizontalmente no topo". A lista, o
 * agrupamento e a marca de seção atual moram em `components/nav.tsx`, que é
 * client component só porque `usePathname` é a única forma de o App Router
 * dizer onde se está.
 *
 * O que o Figma desenha e este Shell NÃO tem, por não existir no sistema —
 * inventar aqui seria inventar produto: seletor de organização (não há segunda
 * organização, e `lib/membership.ts` NOMEIA esse estado em vez de escolher
 * uma), Central de Ajuda, menu de perfil (esconderia o "Sair" atrás de um
 * dropdown que não existe) e botão flutuante do Copiloto (que é rota, e está
 * no menu). Registrado em `docs/DESIGN_IMPLEMENTATION.md`.
 */
export async function Shell({ children }: { children: ReactNode }): Promise<ReactNode> {
  const supabase = await createClient();

  // As TRÊS leituras do cabeçalho, juntas (D-195). Elas não devem nada umas às
  // outras — quem é o usuário, qual a organização, e quantas notificações não
  // lidas — e este componente embrulha **toda página autenticada**: em fila,
  // eram três idas ao banco somadas ao custo da página, em cada navegação.
  // Era o waterfall de maior alcance do app, e o único que se paga 45 vezes.
  //
  // `getUser()` revalida o token contra o servidor de Auth e custa uma ida
  // inteira. Enfileirá-lo não protegia nada: quem barra a rota é o `proxy.ts`,
  // que já chamou `getUser()` nesta mesma requisição e redirecionou para
  // `/login` sem sessão. As outras duas são restringidas pela RLS.
  const [{ data: auth }, membership, unread, preferences] = await Promise.all([
    supabase.auth.getUser(),
    currentMembership(supabase),
    // Badge de não lidas (Fase 7, item 4) — `notification_recipients_select_own`
    // já restringe a própria linha, sem precisar filtrar por user_id aqui.
    supabase.from("notification_recipients").select("*", { count: "exact", head: true }).is("read_at", null),
    // D-197: esta leitura era feita pelo NAVEGADOR, dentro de
    // `NotificationToasts`, em toda página autenticada — uma ida a mais por
    // carregamento, e ela ficava na frente da assinatura de Realtime. Aqui
    // ela entra num `Promise.all` que já existia e não custa latência nenhuma.
    supabase.from("notification_preferences").select("event_type, ml_account_id, min_severity, enabled"),
  ]);

  // Falha aqui degrada para "sem regra", que é o mesmo que o componente fazia
  // quando a leitura do cliente falhava: `shouldNotify` sobre lista vazia
  // deixa passar. Preferência é filtro de toast, nunca de dado — a Central de
  // Notificações continua mostrando tudo.
  const preferenceRules: NotificationPreferenceRule[] = (preferences.data ?? []).map((row) => ({
    eventType: row.event_type,
    mlAccountId: row.ml_account_id,
    minSeverity: row.min_severity,
    enabled: row.enabled,
  }));

  const role = membership.role;
  const orgName = membership.organizationName ?? "Speed Bikers";
  const organizationId = membership.organizationId;
  // Falha aqui (não "sem organização" — isso já é tratado explicitamente em
  // cada página) degradava em silêncio: nome genérico, busca desabilitada
  // (organizationId null), papel sumindo do cabeçalho, sem nenhum sinal —
  // numa tela que roda em TODA página autenticada (D-067, Nível 3).
  const membershipError = membership.error !== null;

  // Falha na contagem degrada pro emblema simplesmente não aparecer: não é
  // dado de negócio (D-067 mirava corrupção de estoque/pedido, não um
  // contador de UI), então sem `⚠` — só some.
  const unreadCount = unread.count ?? 0;

  return (
    <div className="sb-shell">
      <aside className="sb-sidebar">
        <Link
          href="/"
          style={{
            display: "block",
            padding: "var(--sb-space-3)",
            borderBottom: "1px solid var(--sb-primary-border)",
            color: "var(--sb-white)",
            textDecoration: "none",
            fontWeight: 700,
            fontSize: "0.9375rem",
          }}
        >
          {orgName}
        </Link>

        <SidebarNav />
      </aside>

      <div className="sb-workspace">
        <header
          style={{
            background: "var(--sb-surface)",
            borderBottom: "1px solid var(--sb-border)",
            padding: "var(--sb-space-2) var(--sb-space-4)",
            display: "flex",
            alignItems: "center",
            gap: "var(--sb-space-3)",
            flexWrap: "wrap",
          }}
        >
          <CommandPalette organizationId={organizationId} />

          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: "var(--sb-space-3)",
              fontSize: "0.8125rem",
              color: "var(--sb-text-soft)",
            }}
          >
            <Link
              href="/notificacoes"
              style={{ color: "var(--sb-text-soft)", textDecoration: "none", whiteSpace: "nowrap" }}
            >
              Notificações
              {unreadCount > 0 && (
                <span
                  style={{
                    marginLeft: "0.375rem",
                    display: "inline-block",
                    minWidth: "1.125rem",
                    padding: "0 0.25rem",
                    borderRadius: "999px",
                    background: "var(--sb-danger)",
                    color: "var(--sb-white)",
                    fontSize: "0.6875rem",
                    fontWeight: 700,
                    textAlign: "center",
                    lineHeight: "1.125rem",
                  }}
                >
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
            </Link>

            <span>
              {auth.user?.email ?? "—"}
              {role === null ? "" : ` · ${role}`}
              {membershipError && (
                <span
                  role="alert"
                  title="Não foi possível confirmar sua organização — busca e alguns dados podem estar incompletos nesta página."
                  style={{ color: "var(--sb-danger)", marginLeft: "0.375rem", cursor: "help" }}
                >
                  ⚠
                </span>
              )}
            </span>

            <form action="/auth/sign-out" method="post">
              <button
                type="submit"
                style={{
                  border: "1px solid var(--sb-border)",
                  background: "var(--sb-surface)",
                  borderRadius: "var(--sb-radius-md)",
                  padding: "0.25rem 0.625rem",
                  cursor: "pointer",
                  color: "inherit",
                  font: "inherit",
                }}
              >
                Sair
              </button>
            </form>
          </div>
        </header>

        <main style={{ padding: "var(--sb-space-4)", flex: 1, background: "var(--sb-surface)" }}>{children}</main>
      </div>

      <NotificationToasts userId={auth.user?.id ?? null} preferenceRules={preferenceRules} />
    </div>
  );
}
