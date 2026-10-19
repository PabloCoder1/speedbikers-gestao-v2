import { Suspense, type ReactNode } from "react";

import { CarregandoConteudo } from "../../../../components/carregando";
import { Ajuda } from "../../../../components/ajuda";
import { RemoverComConfirmacao } from "../../../../components/remover-com-confirmacao";
import { CabecalhoDaCentral, SendoAtivado } from "../comum";
import { Panel } from "../../../../components/panel";
import { StatePill } from "../../../../components/state-pill";
import { descreverLimites, GRUPOS_DOS_LIMITES, LIMITES_PADRAO, lerLimites } from "../../../../lib/limites-central";
import { currentMembership } from "../../../../lib/request-membership";
import { createClient } from "../../../../lib/supabase/server";
import { EstadoDaTela, TENTAR_DE_NOVO } from "../../../../components/estado-da-tela";
import { voltarAosPadroes } from "./actions";
import { FormularioLimites } from "./formulario";

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
          acao={{ href: "/central/limites", rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
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
    </>
  );
}
