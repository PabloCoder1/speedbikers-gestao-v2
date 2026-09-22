import type { ReactNode } from "react";

/** Escolha explícita de conteúdo antes de baixar um documento do pedido. */
export function ExportActions({ purchaseOrderId }: { purchaseOrderId: string }): ReactNode {
  const base = `/compras/${purchaseOrderId}/export`;

  return (
    <details className="sb-purchase-export">
      <summary className="sb-button">Exportar pedido</summary>
      <div className="sb-purchase-export-menu">
        <div className="sb-purchase-export-group">
          <strong>Para fornecedor</strong>
          <span>Sem custos, subtotais ou total do pedido.</span>
          <div>
            <a className="sb-button sb-button-primary" href={`${base}/xlsx`}>Excel sem valores</a>
            <a className="sb-button sb-button-primary" href={`${base}/pdf`}>PDF sem valores</a>
          </div>
        </div>
        <div className="sb-purchase-export-group sb-purchase-export-internal">
          <strong>Uso interno</strong>
          <span>Inclui custo unitário, subtotais e total.</span>
          <div>
            <a className="sb-button" href={`${base}/xlsx?valores=com`}>Excel com valores</a>
            <a className="sb-button" href={`${base}/pdf?valores=com`}>PDF com valores</a>
          </div>
        </div>
      </div>
    </details>
  );
}
