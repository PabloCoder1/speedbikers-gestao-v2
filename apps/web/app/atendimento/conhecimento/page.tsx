import Link from "next/link";
import type { ReactNode } from "react";

import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { Shell } from "../../../components/shell";
import { formatCount, formatPercent } from "../../../lib/format";
import { createClient } from "../../../lib/supabase/server";
import { KnowledgeRow, type KnowledgeRowData } from "./knowledge-row";
import { NewKnowledgeForm } from "./new-knowledge-form";
import { currentMembership } from "../../../lib/membership";

export const metadata = { title: "Base de Conhecimento — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/**
 * Base de Conhecimento Validada (Fase 7B, D-071/D-113) pelo frame
 * `SupportScreen` na variante de conhecimento (D28, D-268).
 *
 * Qualquer membro sugere; ADMIN/GESTOR validam. SÓ o que está VALIDADO vira
 * evidência do Copiloto na sugestão de resposta — a lista deixa os quatro
 * estados visíveis de propósito, porque rejeitar/obsoletar preserva o
 * histórico da decisão em vez de apagá-lo.
 *
 * **O frame mostra DOIS estados, e são quatro.** Ele desenha "Validado" e
 * "Sugerido"; a `check` da tabela conhece também `REJEITADO` e `OBSOLETO`, e
 * escondê-los apagaria justamente o histórico que a tabela existe para
 * preservar — é a mesma correção que D-265 fez na Central Full.
 *
 * **E o "92% validados" do frame é o número mais delicado da tela.** Ele
 * pressupõe base com conteúdo; a tabela tem **zero linhas no Dev**. Percentual
 * sobre zero é INDEFINIDO, não 0% (D-067), e é assim que a tela o trata.
 */

/** Teto de linhas. A base cresce por escrita humana; 200 é folgado hoje. */
const ROW_LIMIT = 200;

export default async function ConhecimentoPage(): Promise<ReactNode> {
  const supabase = await createClient();

  /*
    As três leituras não dependem umas das outras.

    Os PERFIS saem junto de propósito: `confirmed_by` referencia `auth.users`,
    não `profiles`, então não há embed possível — e buscar os nomes depois, a
    partir dos ids das linhas, seria leitura em fila (D-195). A equipe é
    pequena; trazê-la inteira em paralelo custa uma viagem que já estava
    acontecendo.
  */
  const [entriesResult, membershipResult, profilesResult] = await Promise.all([
    supabase
      .from("knowledge_entries")
      .select("id, kind, content, note, source, status, updated_at, confirmed_by, skus(sku)", {
        count: "exact",
      })
      .order("updated_at", { ascending: false })
      .limit(ROW_LIMIT),
    currentMembership(supabase),
    supabase.from("profiles").select("id, full_name"),
  ]);

  const role = membershipResult.role;
  const canManage = role === "ADMIN" || role === "GESTOR";

  const nomePorId = new Map(
    (profilesResult.data ?? []).map((perfil) => [perfil.id, perfil.full_name] as const),
  );

  const entradas = entriesResult.data ?? [];

  const rows: KnowledgeRowData[] = entradas.map((row) => ({
    id: row.id,
    kind: row.kind,
    content: row.content,
    note: row.note,
    source: row.source,
    status: row.status,
    skuCode: row.skus?.sku ?? null,
    confirmedByName: row.confirmed_by === null ? null : (nomePorId.get(row.confirmed_by) ?? null),
    updatedAt: row.updated_at,
  }));

  const total = entriesResult.count ?? entradas.length;

  /*
    OS TRÊS NÚMEROS DO FRAME, e o segundo é o delicado.

    As contagens por estado saem das linhas JÁ CARREGADAS, o que é exato
    enquanto a busca é completa. Quando ela trunca, as duas derivadas viram
    desconhecidas em vez de erradas: contar 200 de 900 e chamar de percentual
    da base seria pior do que não mostrar.

    E `null` sobre base vazia não é 0%: "nenhum conhecimento validado" e
    "nenhum conhecimento" são estados diferentes, e `formatPercent(null)`
    imprime "—" (D-067).
  */
  const completa = entradas.length === total;
  const validados = completa ? rows.filter((r) => r.status === "VALIDADO").length : null;
  const aguardando = completa ? rows.filter((r) => r.status === "SUGERIDO").length : null;
  const taxaValidados = validados === null || total === 0 ? null : validados / total;

  return (
    <Shell>
      <PageTitle
        eyebrow="ATENDIMENTO / OPERAÇÃO"
        title="Base de Conhecimento"
        subtitle="Respostas confiáveis para a equipe e o Copiloto."
        aside={
          <Link href="/atendimento" style={{ fontSize: "0.6875rem", color: "var(--sb-secondary)" }}>
            ← Caixa de Entrada
          </Link>
        }
      />

      <div className="sb-stat-grid" style={{ marginBottom: "var(--sb-space-3)" }}>
        <div className="sb-stat">
          <span className="sb-stat-label">Conhecimentos registrados</span>
          <b className="sb-stat-value">{formatCount(total)}</b>
          <span className="sb-stat-note">todos os estados, inclusive rejeitados e obsoletos</span>
        </div>

        <div className="sb-stat">
          <span className="sb-stat-label">Validados pela equipe</span>
          <b className="sb-stat-value">{formatPercent(taxaValidados)}</b>
          <span className="sb-stat-note">
            {total === 0
              ? "sem base registrada — indefinido, não 0%"
              : "validados ÷ total, com rejeitados e obsoletos no denominador"}
          </span>
        </div>

        <div className="sb-stat">
          <span className="sb-stat-label">Aguardando revisão</span>
          <b className="sb-stat-value">{aguardando === null ? "—" : formatCount(aguardando)}</b>
          <span className="sb-stat-note">sugeridos, à espera de ADMIN ou GESTOR</span>
        </div>
      </div>

      {entriesResult.error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar o conhecimento: {entriesResult.error.message}
        </p>
      )}

      {entriesResult.error === null && (
        <Panel
          title="Conhecimentos"
          subtitle="Compatibilidade, especificação, política e outros — só o que está VALIDADO vira evidência do Copiloto."
        >
          {rows.length === 0 ? (
            <p className="sb-empty">
              Nenhum conhecimento registrado ainda. O primeiro nasce no formulário abaixo, como{" "}
              <strong>Sugerido</strong>, e vira evidência do Copiloto só depois de um ADMIN ou GESTOR validar.
            </p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="sb-table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Tipo</th>
                    <th>Conhecimento</th>
                    <th>Fonte</th>
                    {/* As duas colunas que o frame acrescenta e o esquema já
                        sustentava — nenhuma das duas era buscada antes. */}
                    <th>Confirmado por</th>
                    <th>Atualizado</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((entry) => (
                    <KnowledgeRow key={entry.id} entry={entry} canManage={canManage} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!completa && (
            <p style={{ margin: "var(--sb-space-2) 1.25rem", fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>
              Mostrando {formatCount(entradas.length)} de {formatCount(total)}, por atualização mais recente —
              e por isso os dois números derivados acima aparecem como “—”: contá-los sobre parte da base seria
              chamar de percentual da base o que é percentual da página.
            </p>
          )}
        </Panel>
      )}

      {/* O "Novo conhecimento" que o frame põe no cabeçalho já existia como
          formulário. Fica onde está: ele é o caminho de escrita da tela, não
          um atalho de barra. */}
      <section style={{ marginTop: "var(--sb-space-4)" }}>
        <h2 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.9375rem" }}>Registrar conhecimento</h2>
        <NewKnowledgeForm />
      </section>
    </Shell>
  );
}
