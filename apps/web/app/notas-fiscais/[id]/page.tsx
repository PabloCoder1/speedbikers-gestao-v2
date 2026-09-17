import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { AutoRefresh } from "../../../components/auto-refresh";
import { ObjectHeader, type ObjectBadge } from "../../../components/object-header";
import { Voltar } from "../../../components/voltar";
import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { ProcessSteps } from "../../../components/process-steps";
import { Shell } from "../../../components/shell";
import { TOM, tomDeStatus } from "../../../components/tone";
import { formatCount, formatCurrency, formatDateTime } from "../../../lib/format";
import { documentTypeLabel } from "../../../lib/document-filters";
import { batchStatusLabel, operationTypeLabel, statusTone } from "../../../lib/labels";
import { nfeEtapas } from "../../../lib/nfe-steps";
import { createClient } from "../../../lib/supabase/server";
import { ConfirmApplyForm } from "./confirm-apply-form";
import { DocumentItemRow } from "./document-item-row";

export const dynamic = "force-dynamic";

/**
 * Tela de conferência da NF-e (D-277, fatia D37).
 *
 * D-253 migrou a LISTA e adiou esta de propósito: o frame da `nfe` é um esboço
 * sem tabela, e quem desenha a conferência é o brief `speed-bikers-design.md`
 * seção 25. Ela entra agora pelo passe visual, e só com os DOIS estados de item
 * que existem — `SUGESTAO` e `CONFLITO` do brief são trabalho de backend antes
 * de serem trabalho de tela (medido em D-253).
 *
 * Terceira etapa do fluxo `upload -> parse -> CONFERÊNCIA -> aplicação`.
 * Cada item mostra o que o XML trouxe e, ao lado, o vínculo humano a um SKU
 * (`docs/NFE.md` secao 3) — sem vínculo, o item não gera movimento na
 * aplicação (`@sb/domain/inventory`, `computeNfeApplicationMovements`).
 *
 * O `.process-steps` do frame entra aqui com QUATRO etapas, não seis: o
 * raciocínio, e a medição que o sustenta, moram em `lib/nfe-steps.ts`.
 */

export default async function NotaFiscalPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<ReactNode> {
  const { id } = await params;

  const supabase = await createClient();

  // As duas leituras partem do MESMO `id` da URL — a dos itens nunca precisou
  // esperar a da nota. Em paralelo desde D-195; a RLS restringe as duas de
  // forma independente, então o guarda de 404 continua abaixo sem virar
  // vazamento, ao custo de uma consulta desperdiçada no caminho raro.
  const [document, items] = await Promise.all([
    supabase
      .from("documents")
      .select(
        "id, file_name, status, access_key, operation_type, document_type, source_format, reference, document_number, series, issue_date, issuer_cnpj, issuer_name, recipient_cnpj, recipient_name, total_items, resolved_items, parsed_at, last_error",
      )
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("document_items")
      .select(
        "id, position, supplier_code, ean, description, ncm, cfop, unit, quantity, unit_value, total_value, sku_id, skus(id, sku, title)",
      )
      .eq("document_id", id)
      .order("position"),
  ]);

  // `null` aqui pode ser "não existe" ou "a policy escondeu". A tela responde
  // igual nos dois casos de propósito — mesmo raciocínio de
  // apps/web/app/importacoes/[id]/page.tsx.
  if (document.error !== null || document.data === null) {
    notFound();
  }

  const info = document.data;

  // Estados de trabalho em curso — mesmo raciocínio de AutoRefresh em
  // apps/web/app/importacoes/[id]/page.tsx.
  const working = info.status === "UPLOADED" || info.status === "PARSING" || info.status === "APPLYING";
  const editable = info.status === "PARSED";

  /*
    Envio ao Full é TRANSFERÊNCIA, não saída: a mercadoria continua nossa, no
    centro do Mercado Livre (D-375, combinado com a frente do Full). A `api`
    recusa a confirmação; a tela não oferece o botão, e diz por quê — oferecer
    para depois recusar seria pior que não oferecer.
  */
  const envioAoFull = info.document_type === "ENVIO_FULL_ML_PDF";

  const badges: readonly ObjectBadge[] = [
    { label: batchStatusLabel(info.status), tom: tomDeStatus(statusTone(info.status)) },
    ...(info.operation_type === null
      ? []
      : [{ label: operationTypeLabel(info.operation_type), tom: "info" as const }]),
  ];

  const etapas = nfeEtapas({
    status: info.status,
    parsedAt: info.parsed_at,
    totalItems: info.total_items,
    resolvedItems: info.resolved_items,
    direcao: info.operation_type,
    tipo: info.document_type,
  });

  // Os fatos do documento. O frame NÃO desenha esta grade — ele nunca chegou a
  // desenhar o detalhe da NF-e —, mas os oito campos existem no XML e a tela
  // antiga já os mostrava soltos abaixo do título. Campo ausente vira "—" e
  // continua na grade: sumir seria a tela dizendo que o campo não existe
  // quando ele só veio vazio (D-067).
  const fatos: readonly (readonly [string, ReactNode])[] = [
    ["Número", info.document_number ?? "—"],
    // O tipo é o que explica por que faltam chave, série e valor num documento
    // que não é nota fiscal (D-375).
    ["Tipo", documentTypeLabel(info.document_type)],
    ...(info.reference === null || info.reference === "" ? [] : ([["Referência", info.reference]] as const)),
    ["Série", info.series ?? "—"],
    ["Emitido em", info.issue_date === null ? "—" : formatDateTime(info.issue_date)],
    ["Itens", formatCount(info.total_items)],
    ["Vinculados", formatCount(info.resolved_items)],
    [
      "Chave de acesso",
      info.access_key === null ? "—" : <span className="sb-mono">{info.access_key}</span>,
    ],
    [
      "Emitente",
      info.issuer_name === null
        ? "—"
        : `${info.issuer_name}${info.issuer_cnpj === null ? "" : ` (${info.issuer_cnpj})`}`,
    ],
    [
      "Destinatário",
      info.recipient_name === null
        ? "—"
        : `${info.recipient_name}${info.recipient_cnpj === null ? "" : ` (${info.recipient_cnpj})`}`,
    ],
  ];

  return (
    <Shell>
      {working && <AutoRefresh />}

      <PageTitle
        eyebrow="ESTOQUE / OPERAÇÃO"
        title="Conferência do documento"
        subtitle="Vincule cada item a um SKU; a baixa no estoque só acontece depois da sua confirmação."
        aside={<Voltar href="/notas-fiscais" rotulo="Notas e Documentos" />}
        compacto
      />

      <ObjectHeader
        identificador={info.document_number === null ? documentTypeLabel(info.document_type) : `${documentTypeLabel(info.document_type)} ${info.document_number}`}
        titulo={info.file_name ?? info.id}
        badges={badges}
        meta={info.parsed_at === null ? undefined : `Lida em ${formatDateTime(info.parsed_at)}`}
      >
        <dl className="sb-fact-grid">
          {fatos.map(([rotulo, valor]) => (
            <div key={rotulo}>
              <dt>{rotulo}</dt>
              <dd>{valor}</dd>
            </div>
          ))}
        </dl>
      </ObjectHeader>

      <div style={{ marginTop: "var(--sb-space-3)" }}>
        <ProcessSteps etapas={etapas} rotulo="Etapas da importação desta NF-e" />
      </div>

      {/* O erro do documento, com o peso de um bloco e o alinhamento de texto
          corrido. `.sb-empty` foi a primeira tentativa e estava errada: ela
          centraliza, e uma mensagem de falha centralizada custa a ser lida.
          Estilo inline porque este é o único consumidor — vira classe quando
          aparecer o segundo (`docs/ARCHITECTURE.md` §1). */}
      {info.last_error !== null && (
        <p
          role="alert"
          style={{
            ...TOM.perigo,
            margin: "0 0 var(--sb-space-3)",
            padding: "var(--sb-space-3)",
            borderRadius: "var(--sb-radius)",
            fontSize: "0.8125rem",
            lineHeight: 1.5,
          }}
        >
          {info.last_error}
        </p>
      )}

      {info.status === "PARSED" && envioAoFull && (
        <p
          role="note"
          style={{
            ...TOM.neutro,
            margin: "0 0 var(--sb-space-3)",
            padding: "var(--sb-space-3)",
            borderRadius: "var(--sb-radius)",
            fontSize: "0.8125rem",
            lineHeight: 1.5,
          }}
        >
          Envio ao Full é <b>transferência</b>, não saída: a mercadoria continua sendo nossa, guardada no centro do
          Mercado Livre. Por isso este documento é lido e conferido, mas não dá baixa no estoque — gravar como saída
          faria as unidades desaparecerem do sistema. A baixa passa a existir quando o Full tiver representação própria
          (D-352).
        </p>
      )}

      {info.status === "PARSED" && !envioAoFull && (
        <ConfirmApplyForm
          documentId={info.id}
          totalItems={info.total_items ?? 0}
          resolvedItems={info.resolved_items ?? 0}
        />
      )}

      {items.error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar os itens: {items.error.message}
        </p>
      )}

      {items.error === null && (
        <Panel
          title="Itens lidos do documento"
          subtitle={
            editable
              ? "Cada item precisa apontar para um SKU antes da confirmação — um documento é aplicado por completo, nunca parcialmente."
              : "Vínculos travados: só documentos em conferência aceitam alteração."
          }
        >
          {items.data.length === 0 && (
            <p className="sb-empty">
              Nenhum item lido deste arquivo ainda. Os itens aparecem quando a leitura termina.
            </p>
          )}

          {items.data.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table className="sb-table">
                <thead>
                  <tr>
                    <th className="sb-num">#</th>
                    <th>Produto no documento</th>
                    <th>Código na origem</th>
                    <th>EAN</th>
                    <th className="sb-num">Quantidade</th>
                    <th className="sb-num">Custo unit.</th>
                    <th className="sb-num">Custo total</th>
                    <th>SKU encontrado</th>
                    <th>Estado</th>
                  </tr>
                </thead>

                <tbody>
                  {items.data.map((item) => (
                    <tr key={item.id}>
                      <td className="sb-num">{item.position + 1}</td>
                      <td>{item.description}</td>
                      <td className="sb-mono">{item.supplier_code}</td>
                      {/* O frame pede EAN em coluna própria, e o dado existe
                          (`document_items.ean`) — estava escondido embaixo da
                          descrição. É o campo que um match automático futuro
                          usaria (docs/NFE.md secao 3). */}
                      <td className="sb-mono">{item.ean ?? "—"}</td>
                      <td className="sb-num">
                        {item.quantity}
                        {item.unit === null ? "" : ` ${item.unit}`}
                      </td>
                      {/*
                        Pedido de separação não traz preço, e zero se leria como
                        "de graça" (D-254): a célula fica muda em vez de afirmar
                        um valor que o documento não tem.
                      */}
                      <td className="sb-num">
                        {item.unit_value === null ? (
                          <span className="sb-rep-mudo">—</span>
                        ) : (
                          formatCurrency(item.unit_value)
                        )}
                      </td>
                      <td className="sb-num">
                        {item.total_value === null ? (
                          <span className="sb-rep-mudo">—</span>
                        ) : (
                          formatCurrency(item.total_value)
                        )}
                      </td>
                      <td style={{ minWidth: "18rem" }}>
                        <DocumentItemRow
                          itemId={item.id}
                          documentId={info.id}
                          editable={editable}
                          linkedSku={item.skus ?? null}
                        />
                      </td>
                      {/* O "Status" do frame não é campo do banco: é o próprio
                          `sku_id`, lido como estado. Derivado, nunca inventado. */}
                      <td>
                        <span className="sb-status" style={TOM[item.sku_id === null ? "atencao" : "ok"]}>
                          {item.sku_id === null ? "Pendente" : "Vinculado"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}
    </Shell>
  );
}
