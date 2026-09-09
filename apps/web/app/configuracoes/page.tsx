import Link from "next/link";
import type { ReactNode } from "react";

import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { StatePill } from "../../components/state-pill";
import type { PillTone } from "../../components/state-pill";
import { formatCount } from "../../lib/format";
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

  const quantas = (estado: SettingState): string =>
    formatCount(secoes.filter((secao) => secao.state === estado).length);

  /*
    SEIS células: o total e as CINCO partes, contadas sobre o mesmo array que
    os painéis imprimem (D-265). Elas respondem, de relance, a pergunta que a
    página inteira responde uma seção por vez: **quanto da minha configuração
    já está feita?**

    "Não editável aqui" e "Indisponível" aparecem mesmo em zero: a primeira é
    o teto de IA, que mora no deploy, e a segunda é leitura que FALHOU. Somar
    as duas ao balde de "não configurado" diria que falta fazer algo que ou
    não se faz aqui, ou não se sabe.
  */
  const celulas: KpiCellData[] = [
    {
      label: "Seções",
      formula: "As áreas de configuração que o sistema tem. É o mesmo conjunto dos painéis abaixo.",
      value: formatCount(secoes.length),
      previous: null,
      tom: "neutro",
    },
    {
      label: "Configuradas",
      formula: "A seção tem tudo o que precisa para o sistema agir sobre ela.",
      value: quantas("configurado"),
      previous: null,
      tom: "ok",
    },
    {
      label: "Parciais",
      formula: "Configurada em parte: uma conta de várias, uma política de algumas.",
      value: quantas("parcial"),
      previous: null,
      tom: "atencao",
    },
    {
      label: "Não configuradas",
      formula: "Nada gravado ainda — e o resumo da seção diz a consequência disso.",
      value: quantas("nao_configurado"),
      previous: null,
      tom: "neutro",
    },
    {
      label: "Não editáveis aqui",
      formula: "Mora fora do produto (deploy, painel do Mercado Livre): nem configurado nem por configurar.",
      value: quantas("nao_editavel"),
      previous: null,
      tom: "neutro",
    },
    {
      label: "Indisponíveis",
      formula: "A leitura falhou. Ausência de resposta não é ausência de configuração (D-067).",
      value: quantas("indisponivel"),
      previous: null,
      tom: "perigo",
    },
  ];

  return (
    <Shell>
      <PageTitle
        eyebrow="ADMINISTRAÇÃO / ORGANIZAÇÃO"
        title="Configurações"
        subtitle="Onde cada configuração mora, se já está feita e quem pode alterar. Esta página não edita nada: cada seção leva para a tela dona, que é a única que valida e grava — assim não existe uma segunda cópia para divergir. As contagens vêm do banco, sob a sua permissão."
      />

      {overview.error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)", fontSize: "0.8125rem" }}>
          Não foi possível ler a visão geral: {sanitizeErrorText(overview.error.message)}
        </p>
      )}

      <KpiStrip cells={celulas} />

      {/*
        SETE PAINÉIS LADO A LADO, e o frame desenha uma NAVEGAÇÃO LATERAL com
        quatro abas e um painel de detalhe.

        Duas razões medidas para não adotá-la:

        1. **São sete seções, não quatro.** As abas do frame (Organização,
           Preferências Operacionais, Notificações, Políticas e Padrões) não
           cobrem Mercado Livre, IA/Copiloto nem Reposição — e é justamente
           Reposição que o seed mostra "não configurado", com consequência.
        2. **O detalhe repetiria a linha.** Cada seção tem quatro frases
           curtas: estado, resumo, quem altera, para onde ir. Um mestre-detalhe
           esconderia seis seções para mostrar uma, e a pergunta que esta
           página existe para responder — "onde eu configuro X, e já está
           feito?" — passaria a exigir um clique por seção. É o critério de
           D-269: detalhe que não acrescenta campo não entra.
      */}
      <div className="sb-pair-grid">
        {secoes.map((secao) => (
          <Panel key={secao.id} title={secao.label} aside={<StatePill tone={STATE_TONE[secao.state]} />}>
            <div className="sb-panel-body" style={{ display: "grid", gap: "0.5rem" }}>
              <p style={{ margin: 0, fontSize: "0.8125rem" }}>{secao.summary}</p>

              <p style={{ margin: 0, fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>
                <strong>Quem altera:</strong> {secao.editors}
              </p>

              <p style={{ margin: 0, fontSize: "0.75rem" }}>
                {secao.links.map((link, index) => (
                  <span key={link.href}>
                    {index > 0 && " · "}
                    <Link href={link.href}>{link.label} →</Link>
                  </span>
                ))}
              </p>
            </div>
          </Panel>
        ))}
      </div>

      {/*
        OS DOIS INTERRUPTORES DO FRAME NÃO ENTRAM, e a medição é curta:

        - **2FA obrigatório**: ZERO colunas de 2FA/MFA no esquema, e ZERO
          fatores cadastrados em `auth.mfa_factors`. O frame o desenha LIGADO,
          o que afirmaria que a organização já exige segundo fator — com
          ninguém tendo um.
        - **Modo manutenção**: ZERO colunas de manutenção ou somente-leitura, e
          `organizations` tem seis colunas ao todo (`id`, `name`, `slug`,
          `cnpj` e os dois carimbos). Não há onde gravar, e não há quem leia.

        **Interruptor mente pior que número.** Um número sem fonte é lido; um
        interruptor sem fonte é ACIONADO — alguém desligaria a operação
        acreditando que as escritas pararam, e elas não parariam. Fazer os dois
        funcionarem é trabalho de produto e de segurança, não de composição:
        exige coluna, política de leitura em todo caminho de escrita e uma
        decisão sobre o que "manutenção" bloqueia.

        "Salvar alterações", a ação do cabeçalho, cai junto: não há o que
        salvar numa página que aponta (D-233).
      */}
    </Shell>
  );
}
