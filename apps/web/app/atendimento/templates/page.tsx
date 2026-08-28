import Link from "next/link";
import type { ReactNode } from "react";

import { Shell } from "../../../components/shell";
import { createClient } from "../../../lib/supabase/server";
import { NewTemplateForm } from "./new-template-form";
import { TemplateRow } from "./template-row";

export const metadata = { title: "Templates de resposta — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/**
 * Gestão de templates de resposta (Fase 7B, D-111).
 *
 * Leitura direta sob RLS (Modelo A); qualquer membro vê, ADMIN/GESTOR
 * gerenciam. O controle NÃO é escondido por CSS de quem não pode — a tela
 * simplesmente não o renderiza, e a barreira real são as policies
 * `reply_templates_*_admin` (mesma postura de D-094: a interface nunca é a
 * barreira).
 */
export default async function TemplatesPage(): Promise<ReactNode> {
  const supabase = await createClient();

  const [templatesResult, membershipResult] = await Promise.all([
    supabase.from("reply_templates").select("id, name, body").order("name"),
    supabase.from("organization_members").select("role").maybeSingle(),
  ]);

  const role = membershipResult.data?.role ?? null;
  const canManage = role === "ADMIN" || role === "GESTOR";

  return (
    <Shell>
      <p style={{ margin: "0 0 var(--sb-space-2)", fontSize: "0.8125rem" }}>
        <Link href="/atendimento" style={{ color: "var(--sb-secondary)" }}>
          ← Caixa de Entrada
        </Link>
      </p>

      <h1 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.375rem" }}>Templates de resposta</h1>

      <p style={{ margin: "0 0 var(--sb-space-4)", color: "var(--sb-text-soft)", fontSize: "0.9375rem" }}>
        Textos prontos que a equipe insere na caixa de resposta e edita antes de confirmar — o
        template nunca envia sozinho.
      </p>

      {templatesResult.error !== null ? (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar os templates: {templatesResult.error.message}
        </p>
      ) : templatesResult.data.length === 0 ? (
        <p style={{ color: "var(--sb-text-soft)" }}>
          Nenhum template ainda.
          {canManage ? " Crie o primeiro abaixo." : " ADMIN ou GESTOR podem criar."}
        </p>
      ) : (
        <ul
          style={{
            listStyle: "none",
            margin: "0 0 var(--sb-space-5)",
            padding: 0,
            display: "grid",
            gap: "var(--sb-space-3)",
            maxWidth: "40rem",
          }}
        >
          {templatesResult.data.map((template) => (
            <TemplateRow key={template.id} template={template} canManage={canManage} />
          ))}
        </ul>
      )}

      {canManage && (
        <section>
          <h2 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.0625rem" }}>Novo template</h2>
          <NewTemplateForm />
        </section>
      )}
    </Shell>
  );
}
