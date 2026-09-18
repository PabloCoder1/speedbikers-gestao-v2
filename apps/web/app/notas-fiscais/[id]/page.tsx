import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { AutoRefresh } from "../../../components/auto-refresh";
import { Icone } from "../../../components/icons";
import { Voltar } from "../../../components/voltar";
import { PageTitle } from "../../../components/page-title";
import { ProcessSteps } from "../../../components/process-steps";
import { Shell } from "../../../components/shell";
import { TOM, tomDeStatus } from "../../../components/tone";
import { formatCount, formatCurrency, formatDateTime } from "../../../lib/format";
import { documentTypeLabel } from "../../../lib/document-filters";
import { erroLegivel } from "../../../lib/document-error";
import { batchStatusLabel, operationTypeLabel, statusTone } from "../../../lib/labels";
import { nfeEtapas } from "../../../lib/nfe-steps";
import { createClient } from "../../../lib/supabase/server";
import { ConfirmApplyForm } from "./confirm-apply-form";
import { DocumentItemRow } from "./document-item-row";

export const dynamic = "force-dynamic";

/**
 * Tela de conferência da NF-e (D-277, fatia D37; refeita no passe visual de
 * 18/09/2026).
 *
 * Terceira etapa do fluxo `upload -> parse -> CONFERÊNCIA -> aplicação`.
 * Cada item mostra o que o documento trouxe e, ao lado, o vínculo humano a um
 * SKU (`docs/NFE.md` secao 3) — sem vínculo, o item não gera movimento na
 * aplicação (`@sb/domain/inventory`, `computeNfeApplicationMovements`).
 *
 * A ordem da página segue a pergunta de quem abre: "de que documento se
 * trata e quanto falta?" (o cartão do documento, com o progresso do vínculo
 * ao lado dos fatos), "onde estamos?" (as etapas), "o que eu faço?" (os
 * itens) e, por último, "posso confirmar?" (a barra de confirmação, presa ao
 * pé da tela enquanto há o que conferir).
 *
 * Só com os DOIS estados de item que existem — `SUGESTAO` e `CONFLITO` do
 * brief são trabalho de backend antes de serem trabalho de tela (D-253). O
 * `.process-steps` tem QUATRO etapas, não seis: o raciocínio mora em
 * `lib/nfe-steps.ts`.
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

  /*
    ERRO não é "não encontrado". Em 18/09/2026 esta tela foi publicada antes
    da migration que cria `documents.reference`: o select falhou, o `if` de
    baixo tratava `error` e `null` igual, e a pessoa viu um 404 cru num
    documento que existia. Agora a falha de leitura diz que é falha — e o 404
    fica só para o que a RLS escondeu ou não existe.
  */
  if (document.error !== null) {
    return (
      <Shell>
        <PageTitle
          eyebrow="ESTOQUE / OPERAÇÃO"
          title="Conferência do documento"
          aside={<Voltar href="/notas-fiscais" rotulo="Notas e Documentos" />}
          compacto
        />
        <section className="sb-panel sb-nf-estado-doc sb-nf-estado-doc-falha" role="alert">
          <span className="sb-nf-estado-doc-icone" aria-hidden="true">
            !
          </span>
          <div>
            <h2>Não foi possível abrir este documento agora</h2>
            <p>O documento não se perdeu: a consulta falhou. Recarregue a página em instantes.</p>
            <details className="sb-nf-detalhe">
              <summary>Detalhe técnico</summary>
              <code>{document.error.message}</code>
            </details>
          </div>
        </section>
      </Shell>
    );
  }

  // `null` aqui pode ser "não existe" ou "a policy escondeu". A tela responde
  // igual nos dois casos de propósito — mesmo raciocínio de
  // apps/web/app/importacoes/[id]/page.tsx.
  if (document.data === null) {
    notFound();
  }

  const info = document.data;
  const linhas = items.error === null ? items.data : [];

  // Estados de trabalho em curso — mesmo raciocínio de AutoRefresh em
  // apps/web/app/importacoes/[id]/page.tsx.
  const working = info.status === "UPLOADED" || info.status === "PARSING" || info.status === "APPLYING";
  const lendo = info.status === "UPLOADED" || info.status === "PARSING";
  const editable = info.status === "PARSED";
  const falhou = info.status === "FAILED";

  /*
    Envio ao Full é TRANSFERÊNCIA, não saída: a mercadoria continua nossa, no
    centro do Mercado Livre (D-375, combinado com a frente do Full). A `api`
    recusa a confirmação; a tela não oferece o botão, e diz por quê — oferecer
    para depois recusar seria pior que não oferecer.
  */
  const envioAoFull = info.document_type === "ENVIO_FULL_ML_PDF";

  const total = info.total_items ?? 0;
  const vinculados = info.resolved_items ?? 0;
  const pendentes = Math.max(total - vinculados, 0);
  const progresso = total === 0 ? 0 : Math.round((vinculados / total) * 100);

  // Somas dos itens JÁ carregados — a tela lê todos os itens do documento, sem
  // janela, então a soma é do documento inteiro. Valor ausente (pedido de
  // separação não traz preço, D-254) não entra como zero: se nenhum item tem
  // valor, o cartão diz "—" em vez de afirmar R$ 0,00.
  const unidades = linhas.reduce((soma, item) => soma + item.quantity, 0);
  const comValor = linhas.filter((item) => item.total_value !== null);
  const valorTotal = comValor.reduce((soma, item) => soma + (item.total_value ?? 0), 0);

  const etapas = nfeEtapas({
    status: info.status,
    parsedAt: info.parsed_at,
    totalItems: info.total_items,
    resolvedItems: info.resolved_items,
    direcao: info.operation_type,
    tipo: info.document_type,
  });

  // Os fatos do documento. Campo ausente vira "—" e continua na grade: sumir
  // seria a tela dizendo que o campo não existe quando ele só veio vazio
  // (D-067).
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
    [
      "Chave de acesso",
      info.access_key === null ? "—" : <span className="sb-mono sb-nf-chave">{info.access_key}</span>,
    ],
  ];

  const erro = info.last_error === null ? null : erroLegivel(info.last_error, { leu: info.parsed_at !== null });
  const formato = info.source_format;

  return (
    <Shell>
      {working && <AutoRefresh />}

      <PageTitle
        eyebrow="ESTOQUE / OPERAÇÃO"
        title="Conferência do documento"
        subtitle="Vincule cada item a um SKU; o estoque só muda depois da sua confirmação."
        aside={<Voltar href="/notas-fiscais" rotulo="Notas e Documentos" />}
        compacto
      />

      {/* O DOCUMENTO: de que se trata, à esquerda; quanto falta, à direita. */}
      <section className="sb-panel sb-nf-doc" aria-labelledby="nf-doc-titulo">
        <div className="sb-nf-doc-topo">
          <span className={`sb-nf-doc-arquivo sb-nf-doc-arquivo-${formato.toLowerCase()}`} aria-hidden="true">
            <Icone nome="recibo" tamanho={20} />
            <small>{formato}</small>
          </span>

          <div className="sb-nf-doc-identidade">
            <span className="sb-eyebrow">
              {info.document_number === null
                ? documentTypeLabel(info.document_type)
                : `${documentTypeLabel(info.document_type)} · Nº ${info.document_number}`}
            </span>
            <h2 id="nf-doc-titulo" title={info.file_name ?? info.id}>
              {info.file_name ?? info.id}
            </h2>
            <div className="sb-nf-doc-selos">
              <span className="sb-status" style={TOM[tomDeStatus(statusTone(info.status))]}>
                {batchStatusLabel(info.status)}
              </span>
              {info.operation_type !== null && (
                <span className="sb-status" style={TOM.info}>
                  {operationTypeLabel(info.operation_type)}
                </span>
              )}
              {info.parsed_at !== null && <small>Lida em {formatDateTime(info.parsed_at)}</small>}
            </div>
          </div>

          {total > 0 && (
            <div className="sb-nf-doc-progresso" aria-label="Progresso do vínculo">
              <div className="sb-nf-doc-progresso-numeros">
                <strong>
                  {formatCount(vinculados)}
                  <span> de {formatCount(total)}</span>
                </strong>
                <small>{pendentes === 0 ? "todos vinculados" : `${formatCount(pendentes)} a vincular`}</small>
              </div>
              <div
                className="sb-nf-barra"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progresso}
                aria-label={`${String(progresso)}% dos itens vinculados`}
              >
                <span style={{ width: `${String(progresso)}%` }} />
              </div>
              <dl className="sb-nf-doc-somas">
                <div>
                  <dt>Unidades</dt>
                  <dd>{formatCount(unidades)}</dd>
                </div>
                <div>
                  <dt>Valor dos itens</dt>
                  <dd>{comValor.length === 0 ? "—" : formatCurrency(valorTotal)}</dd>
                </div>
              </dl>
            </div>
          )}
        </div>

        <dl className="sb-fact-grid">
          {fatos.map(([rotulo, valor]) => (
            <div key={rotulo}>
              <dt>{rotulo}</dt>
              <dd>{valor}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="sb-nf-etapas">
        <ProcessSteps etapas={etapas} rotulo="Etapas da importação deste documento" />
      </div>

      {lendo && (
        <section className="sb-panel sb-nf-estado-doc" role="status">
          <span className="sb-nf-estado-doc-icone sb-nf-estado-doc-icone-girando" aria-hidden="true" />
          <div>
            <h2>Lendo o arquivo…</h2>
            <p>Os itens aparecem aqui sozinhos quando a leitura terminar — não precisa recarregar.</p>
          </div>
        </section>
      )}

      {falhou && erro !== null && (
        <section className="sb-panel sb-nf-estado-doc sb-nf-estado-doc-falha" role="alert">
          <span className="sb-nf-estado-doc-icone" aria-hidden="true">
            !
          </span>
          <div>
            <h2>{info.parsed_at === null ? "Não conseguimos ler este arquivo" : "A aplicação no estoque falhou"}</h2>
            <p>{erro.resumo}</p>
            {erro.detalhe !== null && (
              <details className="sb-nf-detalhe">
                <summary>Detalhe técnico</summary>
                <code>{erro.detalhe}</code>
              </details>
            )}
          </div>
          {info.parsed_at === null && (
            <Link className="sb-button sb-button-primary sb-nf-estado-doc-acao" href="/notas-fiscais/nova">
              <Icone nome="envio" tamanho={14} /> Enviar de novo
            </Link>
          )}
        </section>
      )}

      {/* Falha com texto limpo mas sem `FAILED` (um erro antigo que ficou) — o
          bloco discreto de antes, para não sumir com a informação. */}
      {!falhou && erro !== null && (
        <p role="alert" className="sb-nf-aviso sb-nf-aviso-bad" style={{ marginBottom: "var(--sb-space-3)" }}>
          {erro.resumo}
        </p>
      )}

      {info.status === "PARSED" && envioAoFull && (
        <p role="note" className="sb-nf-nota">
          Envio ao Full é <b>transferência</b>, não saída: a mercadoria continua sendo nossa, guardada no centro do
          Mercado Livre. Por isso este documento é lido e conferido, mas não dá baixa no estoque — gravar como saída
          faria as unidades desaparecerem do sistema. A baixa passa a existir quando o Full tiver representação própria
          (D-352).
        </p>
      )}

      {items.error !== null && (
        <p role="alert" className="sb-nf-aviso sb-nf-aviso-bad">
          Não foi possível carregar os itens: {items.error.message}
        </p>
      )}

      {items.error === null && !lendo && !(falhou && info.parsed_at === null) && (
        <section className="sb-panel sb-nf-itens-painel" aria-labelledby="nf-itens-titulo">
          <header className="sb-nf-itens-cabeca">
            <div>
              <h2 id="nf-itens-titulo">Itens lidos do documento</h2>
              <p>
                {editable
                  ? "Cada item precisa apontar para um SKU antes da confirmação — um documento é aplicado por completo, nunca parcialmente."
                  : "Vínculos travados: só documentos em conferência aceitam alteração."}
              </p>
            </div>
            {linhas.length > 0 && (
              <div className="sb-nf-itens-contagem">
                <span className="sb-nf-contagem sb-nf-contagem-pendente">
                  <b>{formatCount(pendentes)}</b> pendente{pendentes === 1 ? "" : "s"}
                </span>
                <span className="sb-nf-contagem sb-nf-contagem-ok">
                  <b>{formatCount(vinculados)}</b> vinculado{vinculados === 1 ? "" : "s"}
                </span>
              </div>
            )}
          </header>

          {linhas.length === 0 && (
            <p className="sb-empty">Nenhum item lido deste arquivo ainda. Os itens aparecem quando a leitura termina.</p>
          )}

          {linhas.length > 0 && (
            <div className="sb-nf-itens-rolagem">
              <table className="sb-table sb-nf-itens-tabela">
                <thead>
                  <tr>
                    <th className="sb-num">#</th>
                    <th>Produto no documento</th>
                    <th>EAN</th>
                    <th className="sb-num">Quantidade</th>
                    <th className="sb-num">Custo unit.</th>
                    <th className="sb-num">Custo total</th>
                    <th>SKU no sistema</th>
                    <th>Estado</th>
                  </tr>
                </thead>

                <tbody>
                  {linhas.map((item) => (
                    <tr key={item.id} className={item.sku_id === null ? "sb-nf-item-pendente" : undefined}>
                      <td className="sb-num sb-nf-item-posicao">{item.position + 1}</td>
                      <td className="sb-nf-item-produto">
                        <b>{item.description}</b>
                        {/* O código na origem e os fiscais descem para baixo da
                            descrição: são a identidade do item no documento,
                            não uma coluna de leitura. */}
                        <span>
                          <span className="sb-mono">{item.supplier_code}</span>
                          {item.ncm !== null && ` · NCM ${item.ncm}`}
                          {item.cfop !== null && ` · CFOP ${item.cfop}`}
                        </span>
                      </td>
                      {/* O frame pede EAN em coluna própria, e o dado existe
                          (`document_items.ean`). É o campo que um match
                          automático futuro usaria (docs/NFE.md secao 3). */}
                      <td className="sb-mono sb-nf-item-ean">{item.ean ?? "—"}</td>
                      <td className="sb-num">
                        <b>{formatCount(item.quantity)}</b>
                        {item.unit === null ? "" : <small> {item.unit}</small>}
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
                      <td className="sb-nf-item-sku">
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
        </section>
      )}

      {info.status === "PARSED" && !envioAoFull && (
        <ConfirmApplyForm documentId={info.id} totalItems={total} resolvedItems={vinculados} />
      )}
    </Shell>
  );
}
