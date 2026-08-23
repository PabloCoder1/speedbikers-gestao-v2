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

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: "var(--sb-space-1)",
  padding: "0.5rem",
  borderRadius: "var(--sb-radius)",
  border: "1px solid var(--sb-border)",
  fontSize: "1rem",
};

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
          <input name={field.name} required={"required" in field && field.required} style={inputStyle} />
        </label>
      ))}

      <label style={{ fontSize: "0.875rem", fontWeight: 600 }}>
        Observações
        <textarea name="notes" rows={3} style={{ ...inputStyle, resize: "vertical" }} />
      </label>

      {error !== null && (
        <p role="alert" style={{ margin: 0, fontSize: "0.875rem", color: "var(--sb-danger)" }}>
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        style={{
          padding: "0.625rem",
          border: "none",
          borderRadius: "var(--sb-radius)",
          background: "var(--sb-primary)",
          color: "var(--sb-white)",
          fontSize: "1rem",
          fontWeight: 600,
          cursor: busy ? "not-allowed" : "pointer",
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? "Salvando…" : "Cadastrar fornecedor"}
      </button>
    </form>
  );
}
