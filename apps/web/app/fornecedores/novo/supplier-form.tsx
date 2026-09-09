"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { createSupplier } from "../../compras/actions";

const FIELDS = [
  { name: "name", label: "Nome", required: true },
  { name: "legalName", label: "Razão social" },
  { name: "document", label: "CNPJ/CPF" },
  { name: "contactName", label: "Contato" },
  { name: "email", label: "E-mail" },
  { name: "phone", label: "Telefone" },
  { name: "whatsapp", label: "WhatsApp" },
  { name: "website", label: "Site" },
] as const;


export function SupplierForm(): ReactNode {
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(formData: FormData): Promise<void> {
    setBusy(true);
    setError(null);

    const value = (key: string): string | null => {
      const raw = formData.get(key);

      return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
    };

    const name = value("name");

    if (name === null) {
      setError("Preencha o nome do fornecedor.");
      setBusy(false);

      return;
    }

    const result = await createSupplier({
      name,
      legalName: value("legalName"),
      document: value("document"),
      contactName: value("contactName"),
      email: value("email"),
      phone: value("phone"),
      whatsapp: value("whatsapp"),
      website: value("website"),
      notes: value("notes"),
    });

    if (!result.ok) {
      setError(result.message);
      setBusy(false);

      return;
    }

    router.push("/fornecedores");
  }

  return (
    <form
      action={(formData) => {
        void submit(formData);
      }}
      style={{ display: "grid", gap: "var(--sb-space-3)", maxWidth: "32rem" }}
    >
      {FIELDS.map((field) => (
        <label key={field.name} style={{ fontSize: "0.875rem", fontWeight: 600 }}>
          {field.label}
          <input className="sb-input sb-input-full" name={field.name} required={"required" in field && field.required} />
        </label>
      ))}

      <label style={{ fontSize: "0.875rem", fontWeight: 600 }}>
        Observações
        <textarea className="sb-input sb-input-full" name="notes" rows={3} />
      </label>

      {error !== null && (
        <p role="alert" style={{ margin: 0, fontSize: "0.875rem", color: "var(--sb-danger)" }}>
          {error}
        </p>
      )}

      <button
        className="sb-button sb-button-primary"
        type="submit"
        disabled={busy}
      >
        {busy ? "Salvando…" : "Cadastrar fornecedor"}
      </button>
    </form>
  );
}
