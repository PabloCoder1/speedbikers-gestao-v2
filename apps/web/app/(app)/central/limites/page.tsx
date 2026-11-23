import { Suspense, type ReactNode } from "react";

import { CarregandoConteudo } from "../../../../components/carregando";
import { Ajuda } from "../../../../components/ajuda";
import { RemoverComConfirmacao } from "../../../../components/remover-com-confirmacao";
import { CabecalhoDaCentral, SendoAtivado } from "../comum";
import { Panel } from "../../../../components/panel";
import { StatePill } from "../../../../components/state-pill";
import { descreverLimites, GRUPOS_DOS_LIMITES, LIMITES_PADRAO, lerLimites } from "../../../../lib/limites-central";
import { mesmaUrl } from "../../../../lib/mesma-url";
import { currentMembership } from "../../../../lib/request-membership";
import { createClient } from "../../../../lib/supabase/server";
import { EstadoDaTela, TENTAR_DE_NOVO } from "../../../../components/estado-da-tela";
import { voltarAosPadroes } from "./actions";
import { FormularioLimites } from "./formulario";
import { FormularioAlertaDeMargem } from "./alerta-margem";
import { lerAlerta, metaComoTexto } from "../../../../lib/alerta-margem";
import { formatCurrency } from "../../../../lib/format";

export const metadata = { title: "Limites da central — Speed Bikers Gestão" };

// Sessão por cookie e RLS por quem está logado: nada aqui pode ser pré-renderizado.
export const dynamic = "force-dynamic";

/**
 * Limites da central (D-408) — os cortes que decidem quando um número da
 * central é estável, pede atenção ou é perigo. D-148: limiar é decisão do
 * dono, não constante do código.
 *
 * Leitura para todo membro; o formulário e "voltar aos padrões" só para ADMIN
 * e GESTOR — a regra de verdade mora nas policies de `central_thresholds`.
 */
export default function LimitesPage(props: { searchParams: Promise<Consulta> }): ReactNode {
  return (
    <>
      <Suspense fallback={<CarregandoConteudo rotulo="Carregando os limites da central" />}>
        <LimitesContent {...props} />
      </Suspense>
    </>
  );
}

type Consulta = Record<string, string | string[] | undefined>;

/** O cabeçalho e as abas da Central (UX_SYSTEM §6, bloco 1): as abas substituem o "Voltar à central". */
function Titulo({ consulta }: { consulta: Consulta }): ReactNode {
  return (
    <CabecalhoDaCentral
      tela="limites"
      consulta={consulta}
      titulo="Limites da central"
      subtitulo="Quando um número da central é estável, pede atenção ou é perigo — e a partir de quantos pedidos uma comparação vale."
    />
  );
}

async function LimitesContent({ searchParams }: { searchParams: Promise<Consulta> }): Promise<ReactNode> {
  const consulta = await searchParams;
  const supabase = await createClient();
  const membership = await currentMembership();

  if (membership.error !== null) {
    return (
      <>
        <Titulo consulta={consulta} />
        <EstadoDaTela
          tipo="erro"
          titulo="Não foi possível confirmar sua organização."
          descricao="Tente novamente em instantes."
          detalhe={membership.error.message}
          acao={{ href: mesmaUrl("/central/limites", consulta), rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
        />
      </>
    );
  }

  const podeEditar = membership.role === "ADMIN" || membership.role === "GESTOR";

  const resposta =
    membership.organizationId === null
      ? null
      : await supabase
          .from("central_thresholds")
          .select(
            "*",
          )
          .eq("organization_id", membership.organizationId)
          .maybeSingle();

  // Tabela ausente (PGRST205 no PostgREST, 42P01 no Postgres) não é erro: a
  // web da `main` vai ao ar antes de a migration passar pelo workflow de
  // produção (o precedente de Metas e imposto).
  if (resposta?.error != null && (resposta.error.code === "PGRST205" || resposta.error.code === "42P01")) {
    return (
      <>
        <Titulo consulta={consulta} />
        <SendoAtivado>
          Os limites estão sendo ativados neste ambiente: o banco ainda não recebeu a tabela de D-408. Enquanto isso, a
          central julga com os padrões.
        </SendoAtivado>
      </>
    );
  }

  const limites = resposta?.error == null ? lerLimites(resposta?.data ?? null) : LIMITES_PADRAO;
  const descricoes = descreverLimites(limites);
  // Os nove limites agrupados pelo que controlam (UX_SYSTEM §6, bloco 2).
  const grupos = GRUPOS_DOS_LIMITES.map((grupo) => ({
    ...grupo,
    limites: descricoes.filter((d) => grupo.campos.includes(d.campo)),
  }));
  const alteradoEm = resposta?.data?.updated_at ?? null;

  return (
    <>
      <Titulo consulta={consulta} />

      {resposta?.error != null && (
        <EstadoDaTela
          tipo="erro"
          titulo="Não foi possível carregar os limites"
          descricao="A central está julgando com os padrões."
          detalhe={resposta.error.message}
          acao={{ href: mesmaUrl("/central/limites", consulta), rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
        />
      )}

      {!podeEditar && (
        <div className="sb-note">
          <span>SÓ LEITURA</span>
          <p>Mudar os limites é de ADMIN e GESTOR.</p>
        </div>
      )}

      <Panel
        title="Limites"
        subtitle={
          limites.personalizados && alteradoEm !== null
            ? `Definidos pela empresa, alterados em ${new Date(alteradoEm).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}.`
            : "Os padrões do sistema: nenhum limite foi mudado ainda."
        }
        aside={
          <StatePill
            tone={limites.personalizados ? { tom: "info", label: "da empresa" } : { tom: "neutro", label: "padrão" }}
          />
        }
      >
        <div className="sb-panel-body">
          {podeEditar ? (
            <FormularioLimites grupos={grupos} />
          ) : (
            grupos.map((grupo) => (
              <section key={grupo.id} className="sb-limites-grupo" aria-label={grupo.titulo}>
                <h3>{grupo.titulo}</h3>
                <p className="sb-limites-grupo-descricao">{grupo.descricao}</p>
                <dl className="sb-limites-lista">
                  {grupo.limites.map((d) => (
                    <div key={d.campo}>
                      <dt>{d.rotulo}</dt>
                      <dd>
                        <strong>{d.atual}</strong> <span className="sb-texto-suave">{d.dica}</span>
                        <Ajuda pergunta="O que muda se este valor aumentar ou diminuir?">
                          <p>{d.ajuda}</p>
                        </Ajuda>
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))
          )}

          {podeEditar && limites.personalizados && (
            <div className="sb-central-bloco">
              <RemoverComConfirmacao
                acao={voltarAosPadroes}
                rotulo="Voltar aos padrões"
                consequencia="Os nove limites voltam ao padrão do sistema, e a central passa a julgar com eles."
                textoDoBotao="Voltar aos padrões"
                textoDaConfirmacao="Voltar aos padrões"
                pendente="Voltando aos padrões…"
              />
            </div>
          )}

          <div className="sb-note sb-central-bloco">
            <span>O QUE NÃO SE AJUSTA AQUI</span>
            <p>
              A tolerância de cobertura entre os períodos (5 p.p.) e as pontuações do detector de frete são a calibragem do
              sistema, não limites de negócio. O ranking de produtos e o detector têm amostras mínimas próprias.
            </p>
          </div>
        </div>
      </Panel>

      {membership.organizationId !== null && (
        <AlertaDeMargem organizationId={membership.organizationId} podeEditar={podeEditar} />
      )}
    </>
  );
}

const STATUS_DO_EMAIL: Record<string, string> = {
  pending: "na fila",
  sent: "enviado",
  failed: "falhou",
  skipped: "não enviado",
};

/**
 * D-858 — o alerta de venda abaixo da margem: a meta por marca, os e-mails e as
 * últimas vendas que dispararam. A margem é a da Curva ABC (5X), pedido a
 * pedido; o julgamento é do banco, de hora em hora.
 */
async function AlertaDeMargem({ organizationId, podeEditar }: { organizationId: string; podeEditar: boolean }): Promise<ReactNode> {
  const supabase = await createClient();
  const [config, ultimos] = await Promise.all([
    supabase
      .from("margin_alert_settings")
      .select("enabled, default_min_margin, imported_min_margin, imported_brands, email_recipients, updated_at")
      .eq("organization_id", organizationId)
      .maybeSingle(),
    supabase
      .from("sale_margin_alerts")
      .select("id, marketplace, order_ref, sku, title, sold_at, sale_value, margin, min_margin, email_status")
      .eq("organization_id", organizationId)
      .order("detected_at", { ascending: false })
      .limit(10),
  ]);

  // Tabela ausente: a web vai ao ar antes da migration (o precedente dos limites).
  if (config.error !== null && (config.error.code === "PGRST205" || config.error.code === "42P01")) {
    return (
      <Panel title="Alerta de venda abaixo da margem" subtitle="Sendo ativado neste ambiente.">
        <div className="sb-panel-body">
          <SendoAtivado>O banco ainda não recebeu a tabela do alerta de margem (D-858).</SendoAtivado>
        </div>
      </Panel>
    );
  }

  const atual = lerAlerta(config.data ?? null);
  // Sem linha, o agendador não acha a empresa: os padrões aparecem no formulário, mas nada roda até salvar.
  const configurado = config.error === null && config.data !== null;
  const situacao = !configurado ? "não configurado" : atual.enabled ? "ligado" : "desligado";
  const pct = (fracao: number): string => `${metaComoTexto(fracao)}%`;

  return (
    <Panel
      title="Alerta de venda abaixo da margem"
      subtitle={`Cada venda com margem abaixo da meta avisa no sino e por e-mail: ${pct(atual.imported_min_margin)} para as marcas importadas, ${pct(atual.default_min_margin)} para os demais.`}
      aside={<StatePill tone={situacao === "ligado" ? { tom: "info", label: situacao } : { tom: "neutro", label: situacao }} />}
    >
      <div className="sb-panel-body">
        {config.error !== null && (
          <EstadoDaTela
            tipo="erro"
            titulo="Não foi possível carregar o alerta de margem"
            descricao="Os valores abaixo são os padrões, não os da empresa."
            detalhe={config.error.message}
            acao={{ href: "/central/limites", rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
          />
        )}

        {podeEditar ? (
          <FormularioAlertaDeMargem atual={atual} />
        ) : (
          <dl className="sb-limites-lista">
            <div>
              <dt>Situação</dt>
              <dd>{situacao[0]?.toUpperCase()}{situacao.slice(1)}</dd>
            </div>
            <div>
              <dt>Marcas importadas ({pct(atual.imported_min_margin)})</dt>
              <dd>{atual.imported_brands.length === 0 ? "Nenhuma" : atual.imported_brands.join(", ")}</dd>
            </div>
            <div>
              <dt>Demais produtos</dt>
              <dd>{pct(atual.default_min_margin)}</dd>
            </div>
            <div>
              <dt>E-mails</dt>
              <dd>{atual.email_recipients.length === 0 ? "Nenhum: o aviso cai só no sino" : `${String(atual.email_recipients.length)} cadastrado(s)`}</dd>
            </div>
          </dl>
        )}

        <div className="sb-note sb-central-bloco">
          <span>COMO A MARGEM É CALCULADA</span>
          <p>
            (Valor líquido recebido − custo do produto) ÷ valor de venda, a mesma da Curva ABC. No Mercado Livre, o recebido é o
            preço menos a comissão e o frete pago pelo vendedor; na Shopee, o repasse da Shopee. Só entra a venda com frete,
            comissão e custo conhecidos e um produto só no pedido: a que ainda não tem frete é julgada quando ele chegar, até 7
            dias depois. Imposto, Ads e custos fixos ficam fora. A margem mínima da central (nos limites acima) é outra régua.
          </p>
        </div>

        {ultimos.error === null && ultimos.data.length > 0 && (
          <div className="sb-central-tabela">
            <p className="sb-texto-suave">As últimas vendas que dispararam o alerta.</p>
            <table className="sb-table">
              <thead>
                <tr>
                  <th className="sb-col-fixa">Produto</th>
                  <th>Venda</th>
                  <th className="sb-num">Valor</th>
                  <th className="sb-num">Margem</th>
                  <th>E-mail</th>
                </tr>
              </thead>
              <tbody>
                {ultimos.data.map((a) => (
                  <tr key={a.id}>
                    <td className="sb-col-fixa">
                      {a.sku ?? "—"}
                      {a.title === null ? null : <span className="sb-texto-suave"> · {a.title}</span>}
                    </td>
                    <td>
                      {a.marketplace === "SHOPEE" ? "Shopee" : "Mercado Livre"} · {a.order_ref}
                      <br />
                      <span className="sb-texto-suave">
                        {new Date(a.sold_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })}
                      </span>
                    </td>
                    <td className="sb-num">{formatCurrency(a.sale_value)}</td>
                    <td className="sb-num">
                      {pct(a.margin)} <span className="sb-texto-suave">(meta {pct(a.min_margin)})</span>
                    </td>
                    <td>{STATUS_DO_EMAIL[a.email_status] ?? a.email_status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Panel>
  );
}
