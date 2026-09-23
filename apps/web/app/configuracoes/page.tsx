import Link from "next/link";
import type { ReactNode } from "react";

import { Icone } from "../../components/icons";
import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { StatePill } from "../../components/state-pill";
import type { PillTone } from "../../components/state-pill";
import { formatCount } from "../../lib/format";
import { currentMembership } from "../../lib/request-membership";
import { sanitizeErrorText } from "../../lib/sanitize";
import { describeSettings, incluiPara, placarDe, quemAltera, vereditoDe, zonaDe } from "../../lib/settings-hub";
import type { SettingsSection, SettingState } from "../../lib/settings-hub";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Configurações — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio das demais telas.
export const dynamic = "force-dynamic";

/**
 * Hub de Configurações (item "Administração → Configurações" do ROADMAP — D-233).
 *
 * A decisão que o item deixava em aberto — **embutir ou apontar** — está
 * resolvida do lado de APONTAR, e esta página é a prova de que a escolha é
 * segura: ela não tem formulário, não tem botão, não valida nada. Cada área
 * resume o que existe hoje (contado NO BANCO por `get_settings_overview`, numa
 * chamada só, sob a RLS de quem pergunta), diz o que abrange, a consequência
 * quando há uma, quem altera e para onde ir. Um dado, um dono (D-224): zero
 * cópia divergente porque não há cópia — nem do custo de IA, que a Central de
 * Integrações já compõe.
 *
 * ## A composição, e o que cada parte responde
 *
 * 1. **O subtítulo dá o veredito**, computado sobre o MESMO array que imprime
 *    os cartões e com as MESMAS duas contagens da faixa ("1 das 7 áreas ainda
 *    não tem configuração e 2 têm configuração parcial"). Sem leitura não há
 *    veredito — a frase some, não vira zero (D-067). Quem calcula é
 *    `vereditoDe`, peça pura com teste.
 * 2. **A faixa é o único placar da tela**, na primeira dobra, com a ressalva
 *    de cada célula VISÍVEL ao lado do número (METRICS 5C.2): o `title` de
 *    antes não existia no toque nem no teclado.
 * 3. **As áreas são impressas em ZONAS rotuladas por presença de
 *    configuração** — cada rótulo verdadeiro para as pílulas que abriga, para
 *    que zona e pílula não tenham como se contradizer. Nenhum rótulo afirma
 *    saúde: "FALTA CONFIGURAR" não promete que o resto está bem. A ordem
 *    DENTRO de cada zona continua a do ROADMAP, que `describeSettings` fixa.
 *
 * O que a tela responde de verdade continua sendo a pergunta que hoje exige
 * saber o mapa do sistema de cor: "onde eu configuro X, e já está feito?".
 *
 * Fora desta versão, por decisão do item: mover configurações para cá, flags
 * genéricas e qualquer edição de segredo.
 */

const EYEBROW = "ADMINISTRAÇÃO / ORGANIZAÇÃO";

/** A segunda frase do subtítulo, sempre — é a regra da tela inteira. */
const APONTA = "Esta página não edita nada: cada área leva para a tela que valida e grava.";

const STATE_TONE: Record<SettingState, PillTone> = {
  configurado: { tom: "ok", label: "Configurado" },
  parcial: { tom: "atencao", label: "Parcial" },
  nao_configurado: { tom: "neutro", label: "Não configurado" },
  nao_editavel: { tom: "neutro", label: "Não editável aqui" },
  indisponivel: { tom: "perigo", label: "Indisponível" },
};

/**
 * As três zonas. O rótulo afirma PRESENÇA de configuração e nada mais: a
 * saúde de cada área é assunto da tela dona, e prometê-la aqui seria cobrir
 * uma regra morta com um selo verde. Zona vazia não renderiza.
 *
 * A zona 1 abriga `nao_configurado` E `parcial`, e o rótulo tem de ser
 * verdadeiro para os dois: "SEM CONFIGURAÇÃO AINDA" punha "Mercado Livre ·
 * Parcial · 3 de 4 contas conectadas" debaixo de uma frase que dizia que a
 * área não tinha configuração nenhuma. "FALTA CONFIGURAR" vale para as duas
 * pílulas — falta tudo, ou falta parte — e não contém o nome de nenhuma das
 * sete áreas (o e2e localiza região por nome, e o nome casa por pedaço).
 */
const ZONAS = [
  { numero: 1, id: "cfg-zona-sem", rotulo: "FALTA CONFIGURAR" },
  { numero: 2, id: "cfg-zona-com", rotulo: "COM CONFIGURAÇÃO" },
  { numero: 3, id: "cfg-zona-erro", rotulo: "NÃO FOI POSSÍVEL LER" },
] as const;

/**
 * O cartão de uma área — cinco blocos, todos por classe.
 *
 * O aviso NÃO leva `role="alert"`: ele é estado permanente da página, não
 * evento que acabou de acontecer. Leitor de tela que o anuncia a cada
 * renderização transforma a única informação de risco da tela em ruído.
 */
function Cartao({ secao, papel }: { secao: SettingsSection; papel: string | null }): ReactNode {
  // Só os termos que QUEM OLHA vai achar na tela dona: "Convites pendentes"
  // e "Conectar conta" existem, mas só para ADMIN.
  const termos = incluiPara(secao, papel);

  return (
    <Panel title={secao.label} aside={<StatePill tone={STATE_TONE[secao.state]} />}>
      <div className="sb-panel-body sb-settings-body">
        <p className="sb-settings-resumo">{secao.summary}</p>

        {secao.aviso !== null && <p className="sb-note sb-note-atencao sb-settings-aviso">{secao.aviso}</p>}

        {termos.length > 0 && (
          <p className="sb-settings-inclui">
            <strong>Inclui:</strong> {termos.map((termo) => termo.termo).join(", ")}.
          </p>
        )}

        <p className="sb-settings-quem">
          <strong>Quem altera:</strong> {quemAltera(secao, papel)}
        </p>

        {/*
          Chips de 34px, a mesma gramática do `aside` de /integracoes e
          /contas. Eram links de 12px separados por " · ": alvo de toque de
          uma linha de texto, numa tela cuja única ação É ir para outra tela.
        */}
        <nav className="sb-channel-nav sb-settings-links" aria-label={`Telas de ${secao.label}`}>
          {secao.links.map((link) => (
            <Link key={link.href} href={link.href}>
              {link.label} →
            </Link>
          ))}
        </nav>
      </div>
    </Panel>
  );
}

/**
 * A partição em zonas, sobre o MESMO array que a faixa conta — uma fonte só,
 * para que placar e ordem nunca discordem.
 */
function Zonas({ secoes, papel }: { secoes: SettingsSection[]; papel: string | null }): ReactNode {
  return (
    <>
      {ZONAS.map((zona) => {
        const daZona = secoes.filter((secao) => zonaDe(secao.state) === zona.numero);

        if (daZona.length === 0) return null;

        return (
          <section key={zona.id} className="sb-settings-zona" aria-labelledby={zona.id}>
            <p className="sb-eyebrow" id={zona.id}>
              {zona.rotulo}
            </p>

            <div className="sb-settings-grid">
              {daZona.map((secao) => (
                <Cartao key={secao.id} secao={secao} papel={papel} />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

/**
 * O veredito, contado sobre o mesmo array dos cartões e com as mesmas duas
 * contagens da faixa (`vereditoDe`). Sem leitura sobra só a regra da tela:
 * **veredito não se inventa** (D-067), e "0 das 7" seria a invenção mais fácil
 * de todas.
 */
function Subtitulo({ secoes, semLeitura }: { secoes: SettingsSection[]; semLeitura: boolean }): ReactNode {
  const veredito = vereditoDe(secoes, semLeitura);

  if (veredito === null) return APONTA;

  return (
    <>
      <strong>{veredito}</strong> {APONTA}
    </>
  );
}

export default async function ConfiguracoesPage(): Promise<ReactNode> {
  const supabase = await createClient();

  // A linha de quem está logado (filtrada por usuário — D-232): `organization_id`
  // é parâmetro da RPC, dependência real, não fila.
  const membership = await currentMembership();

  if (membership.error !== null) {
    /*
      "Não consegui ler" e "não é membro" são respostas diferentes (D-067) — e
      o que falhou aqui foi ler o ESTADO, não saber onde cada coisa mora. Por
      isso as sete áreas continuam impressas, com os links válidos: é para isso
      que `describeSettings(null)` existe. Sem papel conhecido, "Quem altera"
      volta à prosa impessoal das policies.
    */
    return (
      <Shell>
        <PageTitle eyebrow={EYEBROW} title="Configurações" subtitle={APONTA} compacto />

        <div className="sb-channel-error" role="alert">
          <span className="sb-channel-error-icon" aria-hidden="true">
            <Icone nome="pulso" tamanho={18} />
          </span>
          <div>
            <strong>Não foi possível ler sua organização.</strong>
            <p>{sanitizeErrorText(membership.error.message) ?? "A leitura falhou neste carregamento."}</p>
          </div>
        </div>

        <Zonas secoes={describeSettings(null)} papel={null} />
      </Shell>
    );
  }

  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <Shell>
        <PageTitle eyebrow={EYEBROW} title="Configurações" compacto />

        <Panel title="Acesso indisponível">
          <div className="sb-channel-empty">
            <span className="sb-channel-empty-icon" aria-hidden="true">
              <Icone nome="pessoas" tamanho={20} />
            </span>
            <div>
              <strong>Sua conta ainda não pertence a nenhuma organização.</strong>
              <p>Peça a um administrador para incluir você.</p>
            </div>
          </div>
        </Panel>
      </Shell>
    );
  }

  // Uma chamada: todas as contagens no banco (D-185), sob a RLS de quem pergunta.
  const overview = await supabase.rpc("get_settings_overview", { p_organization_id: organizationId }).maybeSingle();

  /*
    Três formas de "não li", tratadas do mesmo jeito pela faixa e pelo
    veredito: o erro; `maybeSingle()` sobre zero linhas, que devolve `data`
    nulo SEM erro; e a organização que a RLS esconde, que a RPC devolve com
    nome NULL e todas as contagens em zero (`describeSettings` a trata como
    leitura ausente).
  */
  const lida = overview.error === null ? overview.data : null;
  const semLeitura = (lida?.organization_name ?? null) === null;
  const secoes = describeSettings(lida, membership.role);

  /*
    O TRAVESSÃO NO RAMO DE FALHA.

    Sem a leitura, "Configuradas", "Parciais" e "Não configuradas" são
    desconhecidas — e zero ali não é neutro: lê-se como "nada está
    configurado", que é o oposto do que aconteceu. `placarDe` as devolve
    `null`, e `formatCount(null)` imprime "—", a convenção da casa para "não
    medido" (D-067). As outras três continuam números porque continuam
    SABIDAS — o porquê, e a invariante que deixa de valer neste ramo, estão em
    `placarDe`.
  */
  const placar = placarDe(secoes, semLeitura);

  /*
    SEIS células: o total e as CINCO partes, contadas sobre o mesmo array que
    os cartões imprimem (D-265). Elas respondem, de relance, a pergunta que a
    página inteira responde uma área por vez: **quanto da minha configuração
    já está feita?**

    "Não editável aqui" e "Indisponível" aparecem mesmo em zero: a primeira é
    o teto de IA, que mora no deploy, e a segunda é leitura que FALHOU. Somar
    as duas ao balde de "não configurado" diria que falta fazer algo que ou
    não se faz aqui, ou não se sabe.

    A `ressalva` é a ressalva de METRICS 5C.2 e é VISÍVEL: a `formula` continua
    no `title` como texto canônico, mas `title` não existe no toque nem no
    teclado. Nenhuma célula tem `tom` — `KpiStrip` só o lê para pintar o chip
    "ver lista", e aqui nenhuma célula tem `href`.

    Cada ressalva cabe em UMA linha da célula em 390px (113px de texto, Inter
    10px): com as de duas e três linhas a faixa crescia e empurrava a primeira
    zona. A faixa não desce para o rodapé (veto do plano) — quem encolhe é a
    ressalva.

    A DOBRA NÃO FECHA NO CELULAR, e o número tem de ser lido na coordenada
    certa. Acima do `.sb-content` há 78px de barra superior, então a dobra de
    812px da janela fica em 734px do topo do conteúdo. Medido em 2026-09-23
    com a folha do build e o HTML real da página: com os dados de produção o
    primeiro cartão da zona 1 (Operação) termina em 914px da janela — 102px
    abaixo da dobra; com os do seed (Reposição primeiro), em 820 — 8px
    abaixo. A medida anterior (803 "de 812") comparava a coordenada do
    conteúdo com a altura da janela.

    As ressalvas são frases que se sustentam sozinhas no toque, onde o `title`
    não existe: "nada gravado ainda" no lugar de "o cartão diz o efeito" (que
    era falso — "Nenhum filtro salvo seu." não diz efeito nenhum), "leitura que
    falhou" no lugar de "falha, não ausência". E a fórmula de "Configuradas"
    deixou de afirmar saúde ("tem tudo o que precisa para o sistema agir")
    logo ao lado da ressalva que diz "presença, não saúde".
  */
  const celulas: KpiCellData[] = [
    {
      label: "Seções",
      formula: "As áreas de configuração que o sistema tem. É o mesmo conjunto dos cartões abaixo.",
      ressalva: "os cartões abaixo",
      value: formatCount(placar.secoes),
      previous: null,
    },
    {
      label: "Configuradas",
      formula: "Há configuração gravada; se ela está boa é assunto da tela dona.",
      ressalva: "presença, não saúde",
      value: formatCount(placar.configuradas),
      previous: null,
    },
    {
      label: "Parciais",
      formula: "Configurada em parte: uma conta de várias, uma política de algumas.",
      ressalva: "parte feita, parte não",
      value: formatCount(placar.parciais),
      previous: null,
    },
    {
      label: "Não configuradas",
      formula: "Nada gravado ainda na tela dona. Quando isso tem consequência, o cartão a diz.",
      ressalva: "nada gravado ainda",
      value: formatCount(placar.naoConfiguradas),
      previous: null,
    },
    {
      label: "Não editáveis aqui",
      formula: "Mora fora do produto (deploy, painel do Mercado Livre): nem configurado nem por configurar.",
      ressalva: "mora fora do produto",
      value: formatCount(placar.naoEditaveis),
      previous: null,
    },
    {
      label: "Indisponíveis",
      formula: "A leitura falhou. Ausência de resposta não é ausência de configuração.",
      ressalva: "leitura que falhou",
      value: formatCount(placar.indisponiveis),
      previous: null,
    },
  ];

  return (
    <Shell>
      <PageTitle
        eyebrow={EYEBROW}
        title="Configurações"
        subtitle={<Subtitulo secoes={secoes} semLeitura={semLeitura} />}
        compacto
      />

      <KpiStrip cells={celulas} />

      {/* UMA vez. A falha de leitura era dita três: no alerta, em cada uma das
          sete pílulas e em cada resumo. Aqui ela é dita no alerta, e as áreas
          que dependiam dela caem na zona "NÃO FOI POSSÍVEL LER". */}
      {overview.error !== null && (
        <div className="sb-channel-error" role="alert">
          <span className="sb-channel-error-icon" aria-hidden="true">
            <Icone nome="pulso" tamanho={18} />
          </span>
          <div>
            <strong>Não foi possível ler a visão geral.</strong>
            <p>{sanitizeErrorText(overview.error.message) ?? "A leitura falhou neste carregamento."}</p>
          </div>
        </div>
      )}

      {/*
        SETE CARTÕES EM ZONAS, e o frame desenha uma NAVEGAÇÃO LATERAL com
        quatro abas e um painel de detalhe.

        Duas razões medidas para não adotá-la:

        1. **São sete áreas, não quatro.** As abas do frame (Organização,
           Preferências Operacionais, Notificações, Políticas e Padrões) não
           cobrem Mercado Livre, IA/Copiloto nem Reposição — e é justamente
           Reposição que o seed mostra "não configurado", com consequência.
        2. **O detalhe repetiria a linha.** Cada área tem quatro ou cinco
           frases curtas: estado, resumo, o que inclui, quem altera, para onde
           ir. Um mestre-detalhe esconderia seis áreas para mostrar uma, e a
           pergunta que esta página existe para responder — "onde eu configuro
           X, e já está feito?" — passaria a exigir um clique por área. É o
           critério de D-269: detalhe que não acrescenta campo não entra.
      */}
      <Zonas secoes={secoes} papel={membership.role} />

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
