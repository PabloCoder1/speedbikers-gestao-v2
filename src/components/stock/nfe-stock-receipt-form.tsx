"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type Warehouse = {
  key: string;
  name: string;
};

type ReceiptIssue = {
  code: string;
  message: string;
  lineNumber?: number;
  supplierSku?: string;
};

type ReceiptPreview = {
  duplicate: boolean;
  invoice: {
    accessKey: string;
    invoiceNumber: string;
    invoiceSeries: string | null;
    issuedAt: string | null;
    supplierName: string | null;
    supplierDocument: string | null;
    recipientDocument: string | null;
    totalAmount: number | null;
  };
  warehouse: Warehouse | null;
  items: {
    lineNumber: number;
    supplierSku: string;
    description: string | null;
    unit: string | null;
    quantity: number;
    unitValue: number | null;
    totalValue: number | null;
    matched: boolean;
    productSku: string | null;
    productName: string | null;
    issue: string | null;
  }[];
  blockingIssues: ReceiptIssue[];
  totalQuantity: number;
  matchedItemCount: number;
};

type ReceiptSuccess = {
  receiptId: string;
  invoiceNumber: string;
  itemCount: number;
  totalQuantity: number;
  warehouseName: string;
};

type Stage = "closed" | "editing" | "previewing" | "ready" | "committing" | "success" | "error";

const integer = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 4 });
const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateTime = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Sao_Paulo",
});

const errorMessages: Record<string, string> = {
  not_authorized: "Seu perfil não pode alterar o estoque.",
  invalid_receipt_files: "Selecione um arquivo XML e um depósito de destino.",
  invalid_xml_file: "Selecione o arquivo XML da NF-e.",
  invalid_xml: "O arquivo não contém um XML válido.",
  xml_too_large: "O XML ultrapassa o limite permitido de 5 MB.",
  unsupported_fiscal_document: "Envie o XML processado de uma NF-e modelo 55.",
  nfe_not_authorized: "A NF-e não possui protocolo de autorização válido.",
  duplicate_invoice: "Esta NF-e já foi utilizada para dar entrada no estoque.",
  recipient_confirmation_required: "Confirme que o CNPJ destinatário pertence à empresa.",
  stock_changed_since_preview: "O estoque mudou após a conferência. Valide o XML novamente.",
  stock_receipt_has_blocking_issues: "Existem itens que precisam ser corrigidos antes da entrada.",
};

function formatDocument(value: string | null) {
  if (!value) return "Não informado";
  if (/^[0-9]{14}$/.test(value)) {
    return value.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  }
  if (/^[0-9]{11}$/.test(value)) {
    return value.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
  }
  return value;
}

function formatDate(value: string | null) {
  if (!value) return "Não informada";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Data inválida" : dateTime.format(date);
}

function responseMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const record = payload as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  if (typeof record.error === "string") return errorMessages[record.error] ?? fallback;
  return fallback;
}

function maskAccessKey(value: string) {
  return `${value.slice(0, 8)} •••• •••• •••• •••• •••• •••• ${value.slice(-8)}`;
}

export function NfeStockReceiptForm({
  warehouses,
  backendReady,
}: {
  warehouses: Warehouse[];
  backendReady: boolean;
}) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("closed");
  const [preview, setPreview] = useState<ReceiptPreview | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedWarehouse, setSelectedWarehouse] = useState(warehouses[0]?.key ?? "");
  const [recipientConfirmed, setRecipientConfirmed] = useState(false);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [success, setSuccess] = useState<ReceiptSuccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = stage === "previewing" || stage === "committing";
  const isOpen = stage !== "closed";

  function close() {
    if (busy) return;
    setStage("closed");
    setPreview(null);
    setSelectedFile(null);
    setSuccess(null);
    setError(null);
    setRecipientConfirmed(false);
  }

  async function handlePreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    setPreview(null);
    setRecipientConfirmed(false);

    const formData = new FormData(event.currentTarget);
    const xml = formData.get("xml");
    const warehouseKey = formData.get("warehouseKey");
    if (!(xml instanceof File) || xml.size === 0 || typeof warehouseKey !== "string") {
      setError(errorMessages.invalid_receipt_files);
      setStage("error");
      return;
    }

    setSelectedFile(xml);
    setSelectedWarehouse(warehouseKey);
    setStage("previewing");

    try {
      const response = await fetch("/api/stock/receipts/nfe/preview", {
        method: "POST",
        body: formData,
      });
      const payload = await response.json() as ReceiptPreview & { error?: string; message?: string };
      if (!response.ok) {
        throw new Error(responseMessage(payload, "Não foi possível validar a NF-e."));
      }
      setPreview(payload);
      setStage("ready");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível validar a NF-e.");
      setStage("error");
    }
  }

  async function handleCommit() {
    if (
      !selectedFile ||
      !selectedWarehouse ||
      !preview ||
      preview.blockingIssues.length > 0 ||
      !recipientConfirmed
    ) return;
    setError(null);
    setStage("committing");

    try {
      const formData = new FormData();
      formData.append("xml", selectedFile, selectedFile.name);
      formData.append("warehouseKey", selectedWarehouse);
      formData.append("recipientConfirmed", "true");
      const response = await fetch("/api/stock/receipts/nfe/commit", {
        method: "POST",
        body: formData,
      });
      const payload = await response.json() as ReceiptSuccess & { error?: string; message?: string };
      if (!response.ok) {
        throw new Error(responseMessage(payload, "Não foi possível dar entrada no estoque."));
      }
      setSuccess(payload);
      setPreview(null);
      setSelectedFile(null);
      setFileInputKey((current) => current + 1);
      setStage("success");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível dar entrada no estoque.");
      setStage("error");
    }
  }

  return (
    <section className="mb-6 overflow-hidden rounded-2xl border border-blue-200 bg-white shadow-sm" aria-labelledby="nfe-receipt-title">
      <div className="flex flex-col gap-4 bg-blue-50/70 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="nfe-receipt-title" className="text-sm font-semibold text-blue-950">
              Entrada de mercadoria por NF-e
            </h2>
            <Badge variant="info">XML modelo 55</Badge>
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-blue-800">
            Valide os itens pelo SKU do XML antes de acrescentar as quantidades ao depósito escolhido.
          </p>
        </div>
        <Button
          type="button"
          variant={isOpen ? "secondary" : "primary"}
          onClick={() => isOpen ? close() : setStage("editing")}
          disabled={busy || !backendReady || warehouses.length === 0}
          className="shrink-0"
        >
          {isOpen ? "Fechar" : "Dar entrada por NF-e"}
        </Button>
      </div>

      {!backendReady ? (
        <div className="border-t border-blue-100 p-5 text-sm text-amber-800">
          A estrutura de recebimento da NF-e ainda precisa ser aplicada ao banco de dados.
        </div>
      ) : warehouses.length === 0 ? (
        <div className="border-t border-blue-100 p-5 text-sm text-amber-800">
          Importe primeiro o estoque do UpSeller para disponibilizar um depósito de destino.
        </div>
      ) : null}

      {isOpen && backendReady && warehouses.length > 0 ? (
        <div className="border-t border-blue-100 p-5">
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 text-xs leading-5 text-gray-600">
            Baixe o XML da nota no{" "}
            <a
              href="https://meudanfe.com.br/"
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-gray-950 underline underline-offset-4"
            >
              MeuDanfe
            </a>
            . O arquivo é processado para a entrada; o XML bruto e os endereços da nota não são armazenados.
          </div>

          <form onSubmit={handlePreview} className="mt-5 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(220px,0.45fr)_auto] md:items-end">
            <div>
              <label htmlFor="nfe-xml" className="block text-sm font-semibold text-gray-900">
                XML processado da NF-e
              </label>
              <input
                key={fileInputKey}
                id="nfe-xml"
                name="xml"
                type="file"
                accept=".xml,application/xml,text/xml"
                required
                disabled={busy}
                className="mt-2 block w-full cursor-pointer rounded-xl border border-gray-200 bg-gray-50 text-sm text-gray-600 file:mr-4 file:border-0 file:border-r file:border-gray-200 file:bg-white file:px-4 file:py-3 file:text-sm file:font-semibold file:text-gray-950 hover:file:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>
            <div>
              <label htmlFor="nfe-warehouse" className="block text-sm font-semibold text-gray-900">
                Depósito de destino
              </label>
              <select
                id="nfe-warehouse"
                name="warehouseKey"
                value={selectedWarehouse}
                onChange={(event) => setSelectedWarehouse(event.target.value)}
                disabled={busy}
                className="mt-2 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-950 outline-none focus:border-gray-400 focus:bg-white focus:ring-4 focus:ring-gray-100"
              >
                {warehouses.map((warehouse) => (
                  <option key={warehouse.key} value={warehouse.key}>{warehouse.name}</option>
                ))}
              </select>
            </div>
            <Button type="submit" disabled={busy} className="md:mb-px">
              {stage === "previewing" ? "Validando..." : "Validar NF-e"}
            </Button>
          </form>

          {error ? (
            <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          ) : null}

          {preview ? (
            <div className="mt-5 overflow-hidden rounded-2xl border border-gray-200">
              <div className="grid gap-4 bg-gray-50 p-5 sm:grid-cols-2 xl:grid-cols-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">NF-e</p>
                  <p className="mt-1 font-semibold text-gray-950">
                    {preview.invoice.invoiceNumber}{preview.invoice.invoiceSeries ? ` · série ${preview.invoice.invoiceSeries}` : ""}
                  </p>
                  <p className="mt-1 text-xs text-gray-500">{formatDate(preview.invoice.issuedAt)}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Fornecedor</p>
                  <p className="mt-1 truncate font-semibold text-gray-950">{preview.invoice.supplierName ?? "Não informado"}</p>
                  <p className="mt-1 text-xs text-gray-500">{formatDocument(preview.invoice.supplierDocument)}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Destino da nota</p>
                  <p className="mt-1 font-semibold text-gray-950">{formatDocument(preview.invoice.recipientDocument)}</p>
                  <p className="mt-1 text-xs text-gray-500">Depósito: {preview.warehouse?.name ?? "não identificado"}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Resumo</p>
                  <p className="mt-1 font-semibold text-gray-950">
                    {integer.format(preview.totalQuantity)} unidade(s)
                  </p>
                  <p className="mt-1 text-xs text-gray-500">
                    {preview.invoice.totalAmount === null ? "Total não informado" : currency.format(preview.invoice.totalAmount)}
                  </p>
                </div>
              </div>

              <div className="border-t border-gray-200 px-5 py-3 text-xs text-gray-500">
                Chave: <span className="font-mono text-gray-700">{maskAccessKey(preview.invoice.accessKey)}</span>
              </div>

              <div className="overflow-x-auto border-t border-gray-200">
                <table className="w-full min-w-[760px] text-left">
                  <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-400">
                    <tr>
                      <th className="px-5 py-3">Item / SKU XML</th>
                      <th className="px-5 py-3">Produto vinculado</th>
                      <th className="px-5 py-3 text-right">Quantidade</th>
                      <th className="px-5 py-3 text-right">Situação</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {preview.items.map((item) => (
                      <tr key={item.lineNumber} className="text-sm">
                        <td className="px-5 py-4">
                          <p className="font-semibold text-gray-950">{item.supplierSku}</p>
                          <p className="mt-1 max-w-80 truncate text-xs text-gray-500">{item.description ?? "Sem descrição"}</p>
                        </td>
                        <td className="px-5 py-4">
                          <p className="font-semibold text-gray-950">{item.productSku ?? "—"}</p>
                          <p className="mt-1 max-w-80 truncate text-xs text-gray-500">{item.productName ?? item.issue ?? "Sem vínculo"}</p>
                        </td>
                        <td className="px-5 py-4 text-right font-semibold text-gray-950">
                          {integer.format(item.quantity)} {item.unit ?? ""}
                        </td>
                        <td className="px-5 py-4 text-right">
                          <Badge variant={item.matched ? "success" : "danger"}>
                            {item.matched ? "Vinculado" : "Correção necessária"}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {preview.blockingIssues.length > 0 ? (
                <div className="border-t border-red-200 bg-red-50 p-5">
                  <p className="text-sm font-semibold text-red-900">A entrada ainda não pode ser confirmada</p>
                  <ul className="mt-2 space-y-1 text-xs leading-5 text-red-700">
                    {preview.blockingIssues.slice(0, 10).map((issue, index) => (
                      <li key={`${issue.code}-${issue.lineNumber ?? index}`}>
                        {issue.supplierSku ? `${issue.supplierSku}: ` : ""}{issue.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="flex flex-col gap-4 border-t border-emerald-200 bg-emerald-50 p-5 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-emerald-950">Todos os SKUs foram vinculados</p>
                    <p className="mt-1 text-xs text-emerald-800">
                      Confirme para registrar a nota e acrescentar as quantidades ao estoque físico.
                    </p>
                    <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs leading-5 text-emerald-900">
                      <input
                        type="checkbox"
                        checked={recipientConfirmed}
                        onChange={(event) => setRecipientConfirmed(event.target.checked)}
                        className="mt-0.5 h-4 w-4 rounded border-emerald-300"
                      />
                      Conferi o CNPJ do destinatário e confirmo que esta nota pertence à empresa.
                    </label>
                  </div>
                  <Button type="button" onClick={handleCommit} disabled={busy || !recipientConfirmed}>
                    {stage === "committing" ? "Dando entrada..." : "Confirmar entrada"}
                  </Button>
                </div>
              )}
            </div>
          ) : null}

          {success ? (
            <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-5">
              <Badge variant="success">Entrada concluída</Badge>
              <p className="mt-3 text-sm font-semibold text-emerald-950">
                NF-e {success.invoiceNumber}: {integer.format(success.totalQuantity)} unidade(s) adicionada(s) em {success.warehouseName}.
              </p>
              <p className="mt-1 text-xs leading-5 text-emerald-800">
                O saldo abaixo já considera esta entrada. A próxima importação completa do UpSeller fará a reconciliação da base.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
