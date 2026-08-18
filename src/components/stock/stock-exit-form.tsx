"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";

const REASONS = [
  { value: "venda_externa", label: "Venda fora do marketplace" },
  { value: "avaria", label: "Avaria / perda" },
  { value: "uso_interno", label: "Uso interno" },
  { value: "devolucao_fornecedor", label: "Devolução ao fornecedor" },
  { value: "acerto_inventario", label: "Acerto de inventário" },
  { value: "outro", label: "Outro" },
];

const ERROR_LABELS: Record<string, string> = {
  sku_not_found: "SKU não encontrado no estoque do UpSeller.",
  invalid_quantity: "Informe uma quantidade maior que zero.",
  invalid_sku: "Informe um SKU válido.",
  invalid_kind: "Tipo de movimento inválido.",
  not_authorized: "Você não tem permissão para movimentar estoque.",
};

export function StockExitForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await fetch("/api/stock/movements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          sku: data.get("sku"),
          quantity: Number(data.get("quantity")),
          kind: data.get("kind"),
          reason: data.get("reason"),
          note: data.get("note"),
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(ERROR_LABELS[payload?.error] ?? "Não foi possível registrar o movimento.");
        return;
      }

      const quantity = Math.abs(Number(payload?.movement?.quantity ?? 0));
      setSuccess(
        `Movimento registrado: ${quantity} un. de ${payload?.movement?.sourceSku ?? ""}.`,
      );
      form.reset();
      router.refresh();
    } catch {
      setError("Falha de rede ao registrar o movimento.");
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-xs font-semibold text-gray-700 shadow-sm transition hover:bg-gray-50"
      >
        Dar saída manual
      </button>
    );
  }

  return (
    <section className="w-full rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-bold tracking-tight text-gray-950">
            Movimento manual de estoque
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-gray-500">
            Vale até a próxima importação da planilha do UpSeller. Quando ela chegar já
            refletindo esta baixa, o movimento deixa de ser contado automaticamente — sem
            descontar duas vezes.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="shrink-0 text-xs font-semibold text-gray-500 hover:text-gray-950"
        >
          Fechar
        </button>
      </div>

      <form onSubmit={handleSubmit} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <label htmlFor="movement-sku" className="text-xs font-medium text-gray-700">
            SKU físico
          </label>
          <input
            id="movement-sku"
            name="sku"
            required
            maxLength={120}
            placeholder="ex.: 13014"
            className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-gray-950"
          />
        </div>

        <div>
          <label htmlFor="movement-quantity" className="text-xs font-medium text-gray-700">
            Quantidade
          </label>
          <input
            id="movement-quantity"
            name="quantity"
            type="number"
            min={1}
            step={1}
            required
            className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-gray-950"
          />
        </div>

        <div>
          <label htmlFor="movement-kind" className="text-xs font-medium text-gray-700">
            Tipo
          </label>
          <select
            id="movement-kind"
            name="kind"
            defaultValue="manual_exit"
            className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-gray-950"
          >
            <option value="manual_exit">Saída</option>
            <option value="manual_entry">Entrada</option>
            <option value="adjustment">Ajuste</option>
          </select>
        </div>

        <div>
          <label htmlFor="movement-reason" className="text-xs font-medium text-gray-700">
            Motivo
          </label>
          <select
            id="movement-reason"
            name="reason"
            defaultValue="venda_externa"
            className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-gray-950"
          >
            {REASONS.map((reason) => (
              <option key={reason.value} value={reason.value}>
                {reason.label}
              </option>
            ))}
          </select>
        </div>

        <div className="sm:col-span-2 lg:col-span-4">
          <label htmlFor="movement-note" className="text-xs font-medium text-gray-700">
            Observação (opcional)
          </label>
          <input
            id="movement-note"
            name="note"
            maxLength={500}
            className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-gray-950"
          />
        </div>

        <div className="flex items-end">
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? "Registrando..." : "Registrar"}
          </Button>
        </div>
      </form>

      {error ? (
        <p className="mt-3 rounded-xl bg-red-50 px-4 py-2.5 text-xs font-medium text-red-700">
          {error}
        </p>
      ) : null}
      {success ? (
        <p className="mt-3 rounded-xl bg-emerald-50 px-4 py-2.5 text-xs font-medium text-emerald-700">
          {success}
        </p>
      ) : null}
    </section>
  );
}
