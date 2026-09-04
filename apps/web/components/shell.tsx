import Link from "next/link";
import type { ReactNode } from "react";

import { createClient } from "../lib/supabase/server";
import { CommandPalette } from "./command-palette";
import type { NotificationPreferenceRule } from "../lib/notification-preferences";
import { NotificationToasts } from "./notification-toasts";
import { SidebarNav } from "./nav";
import { currentMembership } from "../lib/membership";

/**
 * Moldura das telas autenticadas — sidebar escura, topbar e área central,
 * refeita a partir do FRAME do Figma (`app-shell` em `src/App.tsx`).
 *
 * A primeira versão veio do BRIEF ("sidebar escura", "não usar dezenas de links
 * horizontalmente no topo") e parou aí. O frame tem mais, e o que faltava
 * mudava a composição: bloco de marca de altura fixa com borda, rodapé da
 * sidebar, topbar de 78px com a BUSCA à esquerda ocupando metade da barra,
 * divisor vertical e bloco de perfil com avatar. E o chrome é fixo — só o
 * conteúdo rola.
 *
 * O papel é lido do banco, não do token. Um JWT pode ser antigo — alguém
 * rebaixado de ADMIN para VISUALIZADOR continuaria vendo o menu de ADMIN até o
 * token expirar. Ler de `organization_members` custa uma consulta e elimina a
 * janela.
 *
 * ## O que o frame desenha e este Shell NÃO faz, com o motivo
 *
 * - **Seletor de escopo** (`.account-switch` abre um modal de conta): não há
 *   segunda organização, e `lib/membership.ts` NOMEIA esse estado em vez de
 *   escolher uma (D-232). O bloco vira informação e link: nome da organização,
 *   quantas contas do Mercado Livre estão conectadas, e leva a `/contas`.
 * - **Central de ajuda**: não existe.
 * - **Menu de perfil** (chevron no `.profile`): esconderia o "Sair" atrás de um
 *   dropdown que não foi desenhado. O perfil é informação e o "Sair" fica
 *   visível.
 * - **Botão flutuante do Copiloto**: seria um terceiro caminho para uma rota
 *   que já está no menu e no topbar.
 * - **Botão de recolher a sidebar** (`.collapse`): adiado — ele é o que faz
 *   sentido do trilho de 58px, e trilho pede estado de cliente.
 *
 * Tudo registrado em `docs/DESIGN_IMPLEMENTATION.md`.
 */
function iniciais(texto: string): string {
  const limpo = texto.trim();

  if (limpo === "") return "?";

  const partes = limpo.split(/[\s@._-]+/).filter((parte) => parte !== "");
  const letras = partes.slice(0, 2).map((parte) => parte.charAt(0));

  return letras.join("").toUpperCase() || limpo.charAt(0).toUpperCase();
}

export async function Shell({ children }: { children: ReactNode }): Promise<ReactNode> {
  const supabase = await createClient();

  // As leituras do cabeçalho, JUNTAS (D-195). Elas não devem nada umas às
  // outras — quem é o usuário, qual a organização, quantas notificações não
  // lidas, quais preferências de toast, quantas contas conectadas e quantos
  // atendimentos abertos — e este componente embrulha **toda página
  // autenticada**: em fila, seriam idas somadas ao custo da página, em cada
  // navegação. Era o waterfall de maior alcance do app.
  //
  // As duas últimas nasceram com o frame do Figma: o rodapé da sidebar mostra
  // as contas conectadas e o item da Caixa de Entrada mostra o contador. São
  // números REAIS — o frame desenha um "3" e desenho não é dado. Custam zero
  // ida a mais: entram no `Promise.all` que já existia (D-185, o custo é o
  // round trip).
  //
  // `getUser()` revalida o token contra o servidor de Auth e custa uma ida
  // inteira. Enfileirá-lo não protegia nada: quem barra a rota é o `proxy.ts`,
  // que já chamou `getUser()` nesta mesma requisição e redirecionou para
  // `/login` sem sessão. As outras são restringidas pela RLS.
  const [{ data: auth }, membership, unread, preferences, contas, atendimentos] = await Promise.all([
    supabase.auth.getUser(),
    currentMembership(supabase),
    // Badge de não lidas (Fase 7, item 4) — `notification_recipients_select_own`
    // já restringe a própria linha, sem precisar filtrar por user_id aqui.
    // `notification_id`, e não `id`: a chave é composta e não existe coluna
    // `id` (o defeito que D4 encontrou na Home).
    supabase.from("notification_recipients").select("notification_id", { count: "exact", head: true }).is("read_at", null),
    // D-197: esta leitura era feita pelo NAVEGADOR, dentro de
    // `NotificationToasts`, em toda página autenticada — uma ida a mais por
    // carregamento, e ela ficava na frente da assinatura de Realtime.
    supabase.from("notification_preferences").select("event_type, ml_account_id, min_severity, enabled"),
    supabase.from("ml_accounts").select("id", { count: "exact", head: true }).eq("status", "CONNECTED"),
    supabase.from("support_cases").select("id", { count: "exact", head: true }).neq("internal_status", "RESOLVIDO"),
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
  // contador de UI), então sem `⚠` — só some. Vale para os três contadores.
  const unreadCount = unread.count ?? 0;
  const contasConectadas = contas.error === null ? contas.count : null;
  const atendimentosAbertos = atendimentos.error === null ? atendimentos.count : null;

  const email = auth.user?.email ?? "—";

  return (
    <div className="sb-shell">
      <aside className="sb-sidebar">
        <Link href="/" className="sb-brand">
          <span aria-hidden="true" className="sb-brand-symbol">
            {iniciais(orgName)}
          </span>
          <span style={{ minWidth: 0 }}>
            <b>{orgName}</b>
            <small>GESTÃO V3</small>
          </span>
        </Link>

        <SidebarNav contagens={{ "/atendimento": atendimentosAbertos }} />

        <div className="sb-sidebar-bottom">
          <Link href="/contas" className="sb-account">
            <span aria-hidden="true" className="sb-account-mark">
              {iniciais(orgName)}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <b>{orgName}</b>
              <small>
                {contasConectadas === null
                  ? "contas não verificadas"
                  : `${String(contasConectadas)} ${contasConectadas === 1 ? "conta conectada" : "contas conectadas"}`}
              </small>
            </span>
            <span aria-hidden="true">›</span>
          </Link>
        </div>
      </aside>

      <div className="sb-workspace">
        <header className="sb-topbar">
          <CommandPalette organizationId={organizationId} />

          <div className="sb-top-actions">
            <Link href="/copiloto" className="sb-icon-button" title="Copiloto" aria-label="Copiloto">
              <span aria-hidden="true">✦</span>
            </Link>

            <Link
              href="/notificacoes"
              className="sb-icon-button"
              title="Notificações"
              aria-label={
                unreadCount > 0 ? `Notificações — ${String(unreadCount)} não lidas` : "Notificações"
              }
            >
              <span aria-hidden="true">♧</span>
              {unreadCount > 0 && (
                <span aria-hidden="true" className="sb-icon-count">
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
            </Link>

            <span aria-hidden="true" className="sb-top-rule" />

            <div className="sb-profile">
              <span aria-hidden="true" className="sb-avatar">
                {iniciais(email)}
              </span>
              <span style={{ minWidth: 0 }}>
                <b>{email}</b>
                <small>
                  {role ?? "sem papel"}
                  {membershipError && (
                    <span
                      role="alert"
                      title="Não foi possível confirmar sua organização — busca e alguns dados podem estar incompletos nesta página."
                      style={{ color: "var(--sb-danger)", marginLeft: "0.375rem", cursor: "help" }}
                    >
                      ⚠
                    </span>
                  )}
                </small>
              </span>
            </div>

            <form action="/auth/sign-out" method="post">
              <button type="submit" className="sb-button">
                Sair
              </button>
            </form>
          </div>
        </header>

        <main className="sb-content">{children}</main>
      </div>

      <NotificationToasts userId={auth.user?.id ?? null} preferenceRules={preferenceRules} />
    </div>
  );
}
