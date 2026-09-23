import Link from "next/link";
import type { ReactNode } from "react";

import { FilterMenu } from "../../../components/filter-menu";
import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { Shell } from "../../../components/shell";
import { formatCount, formatDay, formatPercent } from "../../../lib/format";
import { currentMembership } from "../../../lib/request-membership";
import { createClient } from "../../../lib/supabase/server";
import {
  APERTADO_ACIMA_DE,
  buildTemplateHref,
  CAIXA_LIMITE,
  estaApertado,
  TEMPLATE_ORDEM_LABEL,
  TEMPLATE_ORDENS,
  resolveTemplateFilters,
} from "../../../lib/template-filters";
import { NewTemplateForm } from "./new-template-form";
import { TemplateRow, type TemplateRowData } from "./template-row";

export const metadata = { title: "Templates de resposta — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/**
 * O TETO DA LEITURA. Uma organização tem dezenas de templates, não milhares:
 * o nome é único por organização e quem escreve são ADMIN e GESTOR. Com esse
 * tamanho, uma ida que traz tudo é mais barata que paginar — e é ela que
 * permite medir o orçamento da caixa sobre o conjunto INTEIRO, não sobre a
 * página que estiver aberta. O teto existe só para que um caso fora da curva
 * degrade num aviso honesto em vez de numa resposta gigante.
 */
const TETO = 300;

/**
 * Gestão de templates de resposta (Fase 7B, D-111; tela refeita em D-392).
 *
 * Leitura direta sob RLS (Modelo A); qualquer membro vê, ADMIN/GESTOR
 * gerenciam. O controle NÃO é escondido por CSS de quem não pode — a tela
 * simplesmente não o renderiza, e a barreira real são as policies
 * `reply_templates_*_admin` (mesma postura de D-094: a interface nunca é a
 * barreira).
 *
 * ## O que a tela passou a dizer (D-392)
 *
 * Ela listava nome e texto, e nada mais. Três coisas que a operação precisa
 * saber não estavam em lugar nenhum:
 *
 * - **quanto da caixa de resposta o template ocupa.** A caixa tem 2.000
 *   caracteres e `applyTemplate` RECUSA inserir quando o template não cabe
 *   junto do rascunho já escrito. Um template de 1.800 só entra em caixa
 *   vazia — e quem o escreveu não tinha como saber;
 * - **quem escreveu e quando foi mexido.** É texto que a equipe inteira manda
 *   para cliente; "quem mudou isso?" era uma pergunta sem resposta na tela;
 * - **onde está o texto que eu quero.** Sem busca, achar "o da garantia" era
 *   rolar a lista inteira — enquanto a barra de templates DENTRO da resposta
 *   (`/atendimento/perguntas`) já buscava por nome e texto desde sempre.
 *
 * A busca casa nome E texto, igual à da barra da resposta: quem procura
 * "garantia" quer o template que FALA de garantia, mesmo que o nome não diga.
 */
export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const filtros = resolveTemplateFilters(query);
  const supabase = await createClient();

  const [templatesResult, membershipResult] = await Promise.all([
    supabase
      .from("reply_templates")
      .select("id, name, body, created_by, created_at, updated_at")
      // A ordem do BANCO é a alfabética; "maiores primeiro" é ordenado aqui
      // porque PostgREST não ordena por expressão (`char_length(body)`), e
      // inventar uma coluna gerada só para isso custaria migration em três
      // ambientes para reordenar dezenas de linhas já carregadas.
      .order(filtros.ordem === "recentes" ? "updated_at" : "name", {
        ascending: filtros.ordem !== "recentes",
      })
      .limit(TETO),
    currentMembership(),
  ]);

  const role = membershipResult.role;
  const canManage = role === "ADMIN" || role === "GESTOR";
  const todos = templatesResult.data ?? [];

  // O NOME de quem escreveu, numa ida só para todos os autores (o mesmo
  // caminho de `/atendimento/conhecimento`). Depende dos ids da leitura
  // anterior: não é fila evitável, é dependência real.
  const autores = [...new Set(todos.flatMap((linha) => (linha.created_by === null ? [] : [linha.created_by])))];
  const perfisResult =
    autores.length === 0
      ? { data: [], error: null }
      : await supabase.from("profiles").select("id, full_name").in("id", autores);
  const nomePorId = new Map((perfisResult.data ?? []).map((perfil) => [perfil.id, perfil.full_name] as const));

  const termo = filtros.busca?.toLowerCase() ?? null;
  const visiveis = termo === null
    ? todos
    : todos.filter(
        (linha) => linha.name.toLowerCase().includes(termo) || linha.body.toLowerCase().includes(termo),
      );
  const ordenados = filtros.ordem === "maiores"
    ? [...visiveis].sort((a, b) => b.body.length - a.body.length)
    : visiveis;

  const linhas: TemplateRowData[] = ordenados.map((linha) => ({
    id: linha.id,
    name: linha.name,
    body: linha.body,
    autor: linha.created_by === null ? null : (nomePorId.get(linha.created_by) ?? null),
    atualizadoEm: linha.updated_at,
  }));

  const total = todos.length;
  const apertados = todos.filter((linha) => estaApertado(linha.body)).length;
  const ocupacaoMedia = total === 0
    ? null
    : todos.reduce((soma, linha) => soma + linha.body.length, 0) / total / CAIXA_LIMITE;
  const ultimoAjuste = todos.reduce<string | null>(
    (maior, linha) => (maior === null || linha.updated_at > maior ? linha.updated_at : maior),
    null,
  );

  const erro = templatesResult.error?.message ?? null;
  const noTeto = total === TETO;

  return (
    <Shell>
      <PageTitle
        eyebrow="ATENDIMENTO / OPERAÇÃO"
        title="Templates de resposta"
        subtitle="Textos prontos que a equipe insere na caixa de resposta e edita antes de confirmar — o template nunca envia sozinho."
        aside={
          <>
            <Link className="sb-button" href="/atendimento">
              ← Caixa de Entrada
            </Link>
            {canManage && <NewTemplateForm />}
          </>
        }
      />

      <div className="sb-stat-grid" style={{ marginBottom: "var(--sb-space-3)" }}>
        <div className="sb-stat">
          <span className="sb-stat-label">Templates disponíveis</span>
          <b className="sb-stat-value">{erro === null ? formatCount(total) : "—"}</b>
          <span className="sb-stat-note">
            compartilhados pela organização; qualquer membro insere na resposta
          </span>
        </div>
        <div className="sb-stat">
          <span className="sb-stat-label">Espaço médio na caixa</span>
          <b className="sb-stat-value">{formatPercent(ocupacaoMedia)}</b>
          <span className="sb-stat-note">
            a caixa de resposta tem {formatCount(CAIXA_LIMITE)} caracteres; o resto é o que sobra para
            ajustar antes de enviar
          </span>
        </div>
        <div className={apertados > 0 ? "sb-stat sb-template-stat-atencao" : "sb-stat"}>
          <span className="sb-stat-label">Apertados</span>
          <b className="sb-stat-value">{erro === null ? formatCount(apertados) : "—"}</b>
          <span className="sb-stat-note">
            acima de {formatCount(APERTADO_ACIMA_DE)} caracteres: junto de um rascunho já escrito, a
            inserção costuma ser recusada em vez de cortar a frase
          </span>
        </div>
        <div className="sb-stat">
          <span className="sb-stat-label">Último ajuste</span>
          <b className="sb-stat-value">{formatDay(ultimoAjuste)}</b>
          <span className="sb-stat-note">a manutenção mais recente da equipe neste conjunto</span>
        </div>
      </div>

      <Panel
        title="Templates"
        subtitle={
          erro !== null
            ? "Não foi possível ler os templates."
            : total === 0
              ? "Nenhum texto pronto ainda."
              : filtros.busca === null
                ? `${formatCount(total)} ${total === 1 ? "template" : "templates"}, ${TEMPLATE_ORDEM_LABEL[filtros.ordem].toLowerCase()}`
                : `${formatCount(linhas.length)} de ${formatCount(total)} ${total === 1 ? "template" : "templates"} para “${filtros.busca}”`
        }
        aside={
          <FilterMenu
            rotulo={TEMPLATE_ORDEM_LABEL[filtros.ordem]}
            opcoes={TEMPLATE_ORDENS.map((ordem) => ({
              href: buildTemplateHref(filtros, { ordem }),
              label: TEMPLATE_ORDEM_LABEL[ordem],
              ativo: filtros.ordem === ordem,
            }))}
          />
        }
      >
        <div className="sb-template-toolbar">
          <form method="get" action="/atendimento/templates" className="sb-template-search" role="search">
            {filtros.ordem !== "nome" && <input type="hidden" name="ordem" value={filtros.ordem} />}
            <input
              className="sb-input"
              type="search"
              name="busca"
              defaultValue={filtros.busca ?? ""}
              placeholder="Buscar por nome ou pelo texto do template"
              aria-label="Buscar por nome ou pelo texto do template"
            />
            <button className="sb-button" type="submit">
              Buscar
            </button>
          </form>
          {filtros.busca !== null && (
            <Link className="sb-text-button" href={buildTemplateHref(filtros, { busca: null })}>
              Limpar busca
            </Link>
          )}
        </div>

        {erro !== null && (
          <div role="alert" className="sb-template-state sb-template-state-erro">
            <strong>Não foi possível carregar os templates.</strong>
            <span>{erro}</span>
            <Link className="sb-button" href={buildTemplateHref(filtros)}>
              Tentar de novo
            </Link>
          </div>
        )}

        {erro === null && total === 0 && (
          <div className="sb-template-state">
            <strong>A equipe ainda não tem textos prontos</strong>
            <span>
              {canManage
                ? "Um template é a resposta que se repete: garantia, prazo de entrega, troca. A equipe insere na caixa e ajusta antes de enviar."
                : "ADMIN e GESTOR escrevem os templates; qualquer membro insere na resposta depois."}
            </span>
            {canManage && <NewTemplateForm rotulo="Criar o primeiro template" />}
          </div>
        )}

        {erro === null && total > 0 && linhas.length === 0 && (
          <div className="sb-template-state">
            <strong>Nenhum template com esse termo</strong>
            <span>A busca olha o nome e o texto. Tente uma palavra que apareça na resposta.</span>
            <Link className="sb-button" href={buildTemplateHref(filtros, { busca: null })}>
              Ver todos
            </Link>
          </div>
        )}

        {erro === null && linhas.length > 0 && (
          <ul className="sb-template-list">
            {linhas.map((template) => (
              <TemplateRow
                key={template.id}
                template={template}
                canManage={canManage}
                termo={filtros.busca}
              />
            ))}
          </ul>
        )}

        {noTeto && (
          <p className="sb-template-teto">
            Mostrando os {formatCount(TETO)} primeiros templates — o conjunto passou do que esta tela
            carrega de uma vez, e os números acima medem só o que está aqui.
          </p>
        )}
      </Panel>
    </Shell>
  );
}
