import Link from "next/link";
import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { StatePill } from "../../components/state-pill";
import type { PillTone } from "../../components/state-pill";
import { cardStyle } from "../../components/table-styles";
import { currentMembership } from "../../lib/membership";
import { sanitizeErrorText } from "../../lib/sanitize";
import { describeSettings } from "../../lib/settings-hub";
import type { SettingState } from "../../lib/settings-hub";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Configurações — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio das demais telas.
export const dynamic = "force-dynamic";

/**
 * Hub de Configurações (item "Administração → Configurações" do ROADMAP,
 * primeira versão — D-233).
 *
 * A decisão que o item deixava em aberto — **embutir ou apontar** — está
 * resolvida do lado de APONTAR, e esta página é a prova de que a escolha é
 * segura: ela não tem formulário, não tem botão, não valida nada. Cada seção
 * resume o que existe hoje (contado NO BANCO por `get_settings_overview`, numa
 * chamada só, sob a RLS de quem pergunta), diz quem pode alterar e leva para a
 * tela dona. Um dado, um dono (D-224): zero cópia divergente porque não há
 * cópia — nem do custo de IA, que a Central de Integrações já compõe.
 *
 * O que ela responde de verdade é a pergunta que hoje exige saber o mapa do
 * sistema de cor: "onde eu configuro X, e já está configurado?".
 *
 * Fora desta versão, por decisão do item: mover configurações para cá, flags
 * genéricas e qualquer edição de segredo.
 */

const STATE_TONE: Record<SettingState, PillTone> = {
  configurado: { tom: "ok", label: "Configurado" },
  parcial: { tom: "atencao", label: "Parcial" },
  nao_configurado: { tom: "neutro", label: "Não configurado" },
  nao_editavel: { tom: "neutro", label: "Não editável aqui" },
  indisponivel: { tom: "perigo", label: "Indisponível" },
};

export default async function ConfiguracoesPage(): Promise<ReactNode> {
  const supabase = await createClient();

  // A linha de quem está logado (filtrada por usuário — D-232): `organization_id`
  // é parâmetro da RPC, dependência real, não fila.
  const membership = await currentMembership(supabase);

  if (membership.error !== null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Configurações</h1>
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível ler sua organização: {sanitizeErrorText(membership.error.message)}
        </p>
      </Shell>
    );
  }

  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Configurações</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  // Uma chamada: todas as contagens no banco (D-185), sob a RLS de quem pergunta.
  const overview = await supabase.rpc("get_settings_overview", { p_organization_id: organizationId }).maybeSingle();

  const secoes = describeSettings(overview.error === null ? overview.data : null);

  return (
    <Shell>
      <h1 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.375rem" }}>Configurações</h1>

      <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Onde cada configuração mora, se já está feita e quem pode alterar. Esta página <strong>não edita nada</strong>:
        cada seção leva para a tela dona, que é a única que valida e grava — assim não existe uma segunda cópia
        para divergir. As contagens vêm do banco, sob a sua permissão.
      </p>

      {overview.error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)", fontSize: "0.8125rem" }}>
          Não foi possível ler a visão geral: {sanitizeErrorText(overview.error.message)}
        </p>
      )}

      <div
        style={{ display: "grid", gap: "var(--sb-space-3)", gridTemplateColumns: "repeat(auto-fit, minmax(20rem, 1fr))" }}
      >
        {secoes.map((secao) => (
          <section key={secao.id} aria-label={secao.label} style={{ ...cardStyle, gap: "0.375rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "0.75rem" }}>
              <h2 style={{ margin: 0, fontSize: "1.0625rem" }}>{secao.label}</h2>
              <StatePill tone={STATE_TONE[secao.state]} />
            </div>

            <p style={{ margin: 0, fontSize: "0.875rem" }}>{secao.summary}</p>

            <p style={{ margin: 0, fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>
              <strong>Quem altera:</strong> {secao.editors}
            </p>

            <p style={{ margin: 0, fontSize: "0.8125rem" }}>
              {secao.links.map((link, index) => (
                <span key={link.href}>
                  {index > 0 && " · "}
                  <Link href={link.href}>{link.label}</Link>
                </span>
              ))}
            </p>
          </section>
        ))}
      </div>
    </Shell>
  );
}
