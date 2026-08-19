"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { NfeStockReceiptForm } from "@/components/stock/nfe-stock-receipt-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { PurchaseOrderPermissions } from "@/features/auth/get-purchase-order-mutation-access";
import {
  approvePurchaseOrderAction,
  cancelPurchaseOrderAction,
  cancelPurchaseOrderItemRemainingAction,
  changePurchaseOrderTransitAccountingAction,
  createSupplierAction,
  markPurchaseOrderOrderedAction,
  reopenPurchaseOrderAction,
  updatePurchaseOrderDraftAction,
  upsertPurchaseOrderItemAction,
} from "@/features/purchase-orders/actions";
import type { PurchaseOrderDetail } from "@/features/purchase-orders/get-purchase-order-detail";
import type { SupplierOption } from "@/features/purchase-orders/get-suppliers";

const numberFormatter = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
const currencyFormatter = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });

function formatDate(value: string | null) {
  return value ? dateTimeFormatter.format(new Date(value)) : "—";
}

function isOverdue(status: string, expectedAt: string | null) {
  if (status !== "ordered" && status !== "partially_received") return false;
  if (!expectedAt) return false;
  return new Date(expectedAt).getTime() < Date.now();
}

const statusBadge: Record<string, { label: string; variant: "neutral" | "info" | "warning" | "success" | "danger" }> = {
  draft: { label: "Rascunho", variant: "neutral" },
  approved: { label: "Aprovado", variant: "info" },
  ordered: { label: "Em trânsito", variant: "warning" },
  partially_received: { label: "Parcial", variant: "warning" },
  received: { label: "Recebido", variant: "success" },
  cancelled: { label: "Cancelado", variant: "danger" },
};

const eventLabels: Record<string, string> = {
  created: "Pedido criado",
  updated: "Pedido atualizado",
  supplier_changed: "Fornecedor alterado",
  approved: "Pedido aprovado",
  reopened: "Reaberto para rascunho",
  ordered: "Marcado como pedido realizado",
  transit_accounting_changed: "Trânsito de compra alterado",
  receipt_linked: "NF-e vinculada / recebimento",
  remaining_cancelled: "Saldo restante cancelado",
  cancelled: "Pedido cancelado",
};

export function PurchaseOrderDetailView({
  detail,
  suppliers,
  permissions,
}: {
  detail: PurchaseOrderDetail;
  suppliers: SupplierOption[];
  permissions: PurchaseOrderPermissions;
}) {
  const router = useRouter();
  const { items, events, receipts } = detail;
  const [isPending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ type: "error" | "success"; message: string } | null>(null);
  const [supplierId, setSupplierId] = useState(detail.supplierId ?? "");
  const [warehouseKey, setWarehouseKey] = useState(detail.destinationWarehouseKey ?? "");
  const [warehouseName, setWarehouseName] = useState(detail.destinationWarehouseName ?? "");
  const [notes, setNotes] = useState(detail.notes ?? "");
  const [showNewSupplier, setShowNewSupplier] = useState(false);
  const [newSupplierName, setNewSupplierName] = useState("");
  const [newSupplierDocument, setNewSupplierDocument] = useState("");
  const [upsellerConfirmed, setUpsellerConfirmed] = useState(false);
  const [manualSku, setManualSku] = useState("");
  const [manualQuantity, setManualQuantity] = useState("");
  const [manualCost, setManualCost] = useState("");

  const totalOutstanding = items.reduce((sum, item) => sum + item.outstandingQuantity, 0);
  const totalReceived = items.reduce((sum, item) => sum + item.receivedQuantity, 0);
  const totalValue = items.reduce((sum, item) => sum + item.quantityOrdered * (item.unitCost ?? 0), 0);
  const badge = statusBadge[detail.status] ?? statusBadge.draft;
  const overdue = isOverdue(detail.status, detail.expectedAt);
  const hasCancelledUnits = items.some((item) => item.cancelledQuantity > 0);

  function runAction<T extends { error: string | null }>(action: () => Promise<T>, successMessage?: string) {
    setFeedback(null);
    startTransition(async () => {
      const result = await action();
      if (result.error) {
        setFeedback({ type: "error", message: result.error });
        return;
      }
      if (successMessage) setFeedback({ type: "success", message: successMessage });
      router.refresh();
    });
  }

  function handleSaveHeader() {
    runAction(
      () =>
        updatePurchaseOrderDraftAction({
          purchaseOrderId: detail.purchaseOrderId,
          expectedVersion: detail.version,
          supplierId: supplierId || null,
          destinationWarehouseKey: warehouseKey || null,
          destinationWarehouseName: warehouseName || null,
          notes: notes || null,
          clearNotes: notes === "",
        }),
      "Dados do pedido salvos.",
    );
  }

  async function handleCreateSupplier() {
    if (!newSupplierName.trim()) return;
    setFeedback(null);
    startTransition(async () => {
      const result = await createSupplierAction({ name: newSupplierName.trim(), document: newSupplierDocument.trim() || undefined });
      if (result.error) {
        setFeedback({ type: "error", message: result.error });
        return;
      }
      if (result.supplierId) setSupplierId(result.supplierId);
      setShowNewSupplier(false);
      setNewSupplierName("");
      setNewSupplierDocument("");
      router.refresh();
    });
  }

  function handleApprove() {
    runAction(() => approvePurchaseOrderAction({ purchaseOrderId: detail.purchaseOrderId, expectedVersion: detail.version }), "Pedido aprovado.");
  }

  function handleReopen() {
    runAction(() => reopenPurchaseOrderAction({ purchaseOrderId: detail.purchaseOrderId, expectedVersion: detail.version }), "Pedido reaberto para rascunho.");
  }

  function handleMarkOrdered() {
    if (!warehouseKey.trim() || !warehouseName.trim()) {
      setFeedback({ type: "error", message: "Informe o depósito de destino antes de marcar como pedido realizado." });
      return;
    }
    runAction(
      () =>
        markPurchaseOrderOrderedAction({
          purchaseOrderId: detail.purchaseOrderId,
          expectedVersion: detail.version,
          destinationWarehouseKey: warehouseKey.trim(),
          destinationWarehouseName: warehouseName.trim(),
          transitAccountingSource: upsellerConfirmed ? "upseller_confirmed" : "internal",
        }),
      "Pedido marcado como realizado.",
    );
  }

  function handleCancel() {
    if (!window.confirm("Cancelar este pedido de compra?")) return;
    runAction(() => cancelPurchaseOrderAction({ purchaseOrderId: detail.purchaseOrderId, expectedVersion: detail.version }), "Pedido cancelado.");
  }

  function handleChangeTransit(source: "internal" | "upseller_confirmed") {
    runAction(
      () => changePurchaseOrderTransitAccountingAction({ purchaseOrderId: detail.purchaseOrderId, expectedVersion: detail.version, transitAccountingSource: source }),
      "Trânsito de compra atualizado.",
    );
  }

  function handleCancelRemaining(purchaseOrderItemId: string) {
    if (!window.confirm("Cancelar o saldo restante deste item?")) return;
    runAction(
      () => cancelPurchaseOrderItemRemainingAction({ purchaseOrderId: detail.purchaseOrderId, expectedVersion: detail.version, purchaseOrderItemId }),
      "Saldo restante cancelado.",
    );
  }

  function handleAddManualItem() {
    const quantity = Number(manualQuantity);
    if (!manualSku.trim() || !Number.isFinite(quantity) || quantity <= 0) return;
    runAction(
      () =>
        upsertPurchaseOrderItemAction({
          purchaseOrderId: detail.purchaseOrderId,
          expectedVersion: detail.version,
          sourceSkuKey: manualSku.trim().toUpperCase(),
          quantityOrdered: quantity,
          unitCost: manualCost ? Number(manualCost) : null,
          isManualAdd: true,
        }),
      "Item adicionado ao pedido.",
    );
    setManualSku("");
    setManualQuantity("");
    setManualCost("");
  }

  const isDraft = detail.status === "draft";
  const isApproved = detail.status === "approved";
  const isOrdered = detail.status === "ordered" || detail.status === "partially_received";

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium text-gray-500">Pedido de compra</p>
          <div className="mt-1 flex items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-tight text-gray-950">{detail.orderNumber}</h1>
            <Badge variant={badge.variant}>{badge.label}</Badge>
            {overdue ? <Badge variant="danger">Atrasado</Badge> : null}
            {hasCancelledUnits ? <Badge variant="neutral">Possui unidades canceladas</Badge> : null}
          </div>
        </div>
      </header>

      {feedback ? (
        <div
          className={`mt-6 rounded-2xl border p-4 text-sm ${
            feedback.type === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-800"
          }`}
        >
          {feedback.message}
        </div>
      ) : null}

      <Card className="mt-6 p-6">
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5">
          <Fact label="Fornecedor" value={detail.supplierName ?? "—"} />
          <Fact label="Criado" value={formatDate(detail.createdAt)} />
          <Fact label="Aprovado" value={formatDate(detail.approvedAt)} />
          <Fact label="Pedido" value={formatDate(detail.orderedAt)} />
          <Fact label="Previsão" value={formatDate(detail.expectedAt)} />
          <Fact label="Destino" value={detail.destinationWarehouseName ?? "—"} />
          <Fact label="Total" value={currencyFormatter.format(totalValue)} />
          <Fact label="Recebido" value={numberFormatter.format(totalReceived)} />
          <Fact label="Pendente" value={numberFormatter.format(totalOutstanding)} />
          <Fact
            label="Trânsito de compra"
            value={detail.transitAccountingSource === "upseller_confirmed" ? "Já refletido no UpSeller" : "Trânsito interno"}
          />
        </div>
      </Card>

      {isDraft && permissions.canEditDraft ? (
        <Card className="mt-6 p-6">
          <h2 className="text-sm font-semibold text-gray-900">Fornecedor e destino</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-semibold text-gray-600">Fornecedor</label>
              <select
                value={supplierId}
                onChange={(event) => setSupplierId(event.target.value)}
                className="mt-1 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:border-gray-400 focus:bg-white focus:ring-4 focus:ring-gray-100"
              >
                <option value="">Selecione um fornecedor</option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => setShowNewSupplier((value) => !value)} className="mt-2 text-xs font-semibold text-blue-700 hover:underline">
                Novo fornecedor
              </button>
              {showNewSupplier ? (
                <div className="mt-2 space-y-2 rounded-xl border border-gray-200 bg-gray-50 p-3">
                  <input
                    value={newSupplierName}
                    onChange={(event) => setNewSupplierName(event.target.value)}
                    placeholder="Nome do fornecedor"
                    className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
                  />
                  <input
                    value={newSupplierDocument}
                    onChange={(event) => setNewSupplierDocument(event.target.value)}
                    placeholder="CNPJ/CPF (opcional)"
                    className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
                  />
                  <Button type="button" size="sm" onClick={handleCreateSupplier} disabled={isPending || !newSupplierName.trim()}>
                    Criar fornecedor
                  </Button>
                </div>
              ) : null}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-gray-600">Depósito (chave)</label>
                <input
                  value={warehouseKey}
                  onChange={(event) => setWarehouseKey(event.target.value)}
                  className="mt-1 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-600">Depósito (nome)</label>
                <input
                  value={warehouseName}
                  onChange={(event) => setWarehouseName(event.target.value)}
                  className="mt-1 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-semibold text-gray-600">Observações</label>
                <textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  rows={2}
                  className="mt-1 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm"
                />
              </div>
            </div>
          </div>
          <Button className="mt-4" onClick={handleSaveHeader} disabled={isPending}>
            Salvar dados do pedido
          </Button>
        </Card>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-3">
        {isDraft && permissions.canApprove ? (
          <Button onClick={handleApprove} disabled={isPending}>
            Aprovar pedido
          </Button>
        ) : null}
        {isApproved && permissions.canReopen ? (
          <Button variant="secondary" onClick={handleReopen} disabled={isPending}>
            Reabrir para rascunho
          </Button>
        ) : null}
        {isApproved && permissions.canMarkOrdered ? (
          <div className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-3 sm:flex-row sm:items-center">
            {!detail.destinationWarehouseKey ? (
              <div className="flex gap-2">
                <input
                  value={warehouseKey}
                  onChange={(event) => setWarehouseKey(event.target.value)}
                  placeholder="Depósito (chave)"
                  className="w-36 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs"
                />
                <input
                  value={warehouseName}
                  onChange={(event) => setWarehouseName(event.target.value)}
                  placeholder="Depósito (nome)"
                  className="w-36 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs"
                />
              </div>
            ) : null}
            <label className="flex items-start gap-2 text-xs leading-5 text-gray-700">
              <input type="checkbox" checked={upsellerConfirmed} onChange={(event) => setUpsellerConfirmed(event.target.checked)} className="mt-0.5" />
              <span>
                Este pedido já está refletido no campo Em Trânsito do UpSeller?
                <br />
                <span className="text-gray-500">Só marque depois de confirmar que o Em Trânsito do UpSeller já contém este pedido.</span>
              </span>
            </label>
            <Button onClick={handleMarkOrdered} disabled={isPending}>
              Marcar como pedido realizado
            </Button>
          </div>
        ) : null}
        {isOrdered && permissions.canChangeTransitAccounting ? (
          <select
            value={detail.transitAccountingSource}
            onChange={(event) => handleChangeTransit(event.target.value as "internal" | "upseller_confirmed")}
            disabled={isPending}
            className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-700"
          >
            <option value="internal">Trânsito interno</option>
            <option value="upseller_confirmed">Já refletido no UpSeller</option>
          </select>
        ) : null}
        {(isDraft || isApproved) && permissions.canCancel ? (
          <Button variant="danger" onClick={handleCancel} disabled={isPending}>
            Cancelar pedido
          </Button>
        ) : null}
      </div>

      <Card className="mt-6 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-[1200px] w-full text-sm">
            <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-400">
              <tr>
                <th className="px-4 py-3 text-left">SKU</th>
                <th className="px-4 py-3 text-left">Produto</th>
                <th className="px-4 py-3 text-right">Sugestão original</th>
                <th className="px-4 py-3 text-right">Pedido</th>
                <th className="px-4 py-3 text-right">Recebido</th>
                <th className="px-4 py-3 text-right">Pendente</th>
                <th className="px-4 py-3 text-right">Custo unitário</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3 text-right">Lead time</th>
                <th className="px-4 py-3 text-left">Motivo</th>
                {isOrdered && permissions.canCancelRemaining ? <th className="px-4 py-3" /> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((item) => (
                <tr key={item.purchaseOrderItemId} className="text-sm align-top">
                  <td className="px-4 py-3 font-mono text-xs text-gray-700">{item.sourceSku}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{item.titleSnapshot ?? "—"}</div>
                    <div className="text-xs text-gray-500">{item.brandSnapshot ?? "Sem marca"}</div>
                  </td>
                  <td className="px-4 py-3 text-right">{numberFormatter.format(item.suggestedQuantitySnapshot ?? 0)}</td>
                  <td className="px-4 py-3 text-right font-semibold">{numberFormatter.format(item.quantityOrdered)}</td>
                  <td className="px-4 py-3 text-right">
                    {numberFormatter.format(item.receivedQuantity)}
                    {item.overReceivedQuantity > 0 ? (
                      <div className="text-[11px] text-amber-700">+{numberFormatter.format(item.overReceivedQuantity)} acima do pedido</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-right">{numberFormatter.format(item.outstandingQuantity)}</td>
                  <td className="px-4 py-3 text-right">{item.unitCost !== null ? currencyFormatter.format(item.unitCost) : "—"}</td>
                  <td className="px-4 py-3 text-right">{currencyFormatter.format(item.quantityOrdered * (item.unitCost ?? 0))}</td>
                  <td className="px-4 py-3 text-right">{item.leadTimeDaysSnapshot ?? "—"}d</td>
                  <td className="px-4 py-3 text-xs text-gray-600">
                    <div>Disponível no momento: {numberFormatter.format(item.physicalAvailableSnapshot ?? 0)}</div>
                    <div>Giro 30d: {numberFormatter.format(item.avgDailySales30Snapshot ?? 0)}/dia</div>
                    <div>Lead time: {item.leadTimeDaysSnapshot ?? "—"} dias</div>
                    <div>Sugestão: {numberFormatter.format(item.suggestedQuantitySnapshot ?? 0)}</div>
                    {item.planningStatusSnapshot === "manual_add" ? <div className="text-gray-400">Adicionado manualmente</div> : null}
                  </td>
                  {isOrdered && permissions.canCancelRemaining ? (
                    <td className="px-4 py-3 text-right">
                      {item.outstandingQuantity > 0 ? (
                        <button
                          type="button"
                          onClick={() => handleCancelRemaining(item.purchaseOrderItemId)}
                          disabled={isPending}
                          className="text-xs font-semibold text-red-600 hover:underline"
                        >
                          Cancelar saldo restante
                        </button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {isDraft && permissions.canEditDraft ? (
        <Card className="mt-6 p-6">
          <h2 className="text-sm font-semibold text-gray-900">Adicionar SKU manualmente</h2>
          <p className="mt-1 text-xs text-gray-500">Kits não podem ser adicionados diretamente — compre os componentes físicos.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_140px_140px_auto]">
            <input
              value={manualSku}
              onChange={(event) => setManualSku(event.target.value)}
              placeholder="SKU físico UpSeller"
              className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm"
            />
            <input
              value={manualQuantity}
              onChange={(event) => setManualQuantity(event.target.value)}
              placeholder="Quantidade"
              type="number"
              min="1"
              className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm"
            />
            <input
              value={manualCost}
              onChange={(event) => setManualCost(event.target.value)}
              placeholder="Custo unitário"
              type="number"
              step="0.01"
              className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm"
            />
            <Button type="button" onClick={handleAddManualItem} disabled={isPending}>
              Adicionar SKU
            </Button>
          </div>
        </Card>
      ) : null}

      {isOrdered && permissions.canReceiveNfe ? (
        <div className="mt-6">
          <NfeStockReceiptForm
            warehouses={
              detail.destinationWarehouseKey
                ? [{ key: detail.destinationWarehouseKey, name: detail.destinationWarehouseName ?? detail.destinationWarehouseKey }]
                : []
            }
            backendReady
            purchaseOrderId={detail.purchaseOrderId}
            defaultWarehouseKey={detail.destinationWarehouseKey ?? undefined}
          />
        </div>
      ) : null}

      {receipts.length > 0 ? (
        <Card className="mt-6 p-6">
          <h2 className="text-sm font-semibold text-gray-900">NF-e recebidas</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {receipts.map((receipt) => (
              <li key={receipt.receiptId} className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 pb-2 text-gray-700">
                <span className="font-semibold">{receipt.invoiceNumber}</span>
                <span className="text-xs text-gray-500">{formatDate(receipt.appliedAt)}</span>
                <span>{numberFormatter.format(receipt.items.reduce((sum, item) => sum + item.quantity, 0))} un.</span>
                <span>{receipt.totalAmount !== null ? currencyFormatter.format(receipt.totalAmount) : "—"}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="mt-6 p-6">
        <h2 className="text-sm font-semibold text-gray-900">Linha do tempo</h2>
        <ol className="mt-3 space-y-3 text-sm">
          {events.map((event, index) => (
            <li key={`${event.eventType}-${event.createdAt}-${index}`} className="flex items-center justify-between border-b border-gray-100 pb-2 text-gray-700">
              <span>{eventLabels[event.eventType] ?? event.eventType}</span>
              <span className="text-xs text-gray-500">{formatDate(event.createdAt)}</span>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</p>
      <p className="mt-1 text-sm font-semibold text-gray-950">{value}</p>
    </div>
  );
}
