import type { ReactNode } from "react";

import { PageTitle } from "../../../../components/page-title";
import { Voltar } from "../../../../components/voltar";
import { currentMembership } from "../../../../lib/request-membership";
import { SaidaManualForm } from "./saida-manual-form";

export const metadata = { title: "Saída manual — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/** O mesmo corte do ajuste manual por SKU e da rota da `api` — a tela avisa antes, a `api` decide. */
const PODE_DAR_SAIDA = new Set(["ADMIN", "GESTOR"]);

/**
 * Saída Manual (D-766) — a saída sem documento: perdas, transferências, o que
 * sai da loja sem nota nem envio ao Full. Vários SKUs de uma vez, como o
 * "Criar Saída" do UpSeller. A baixa é imediata; quem tem um documento usa
 * "Enviar documento", que passa pela conferência.
 */
export default async function SaidaManualPage(): Promise<ReactNode> {
  const membership = await currentMembership();
  const pode = membership.role !== null && PODE_DAR_SAIDA.has(membership.role);

  return (
    <>
      <PageTitle
        eyebrow="ESTOQUE / OPERAÇÃO"
        title="Saída manual"
        subtitle="Baixa do estoque da loja sem documento — perdas, transferências e outras saídas, vários SKUs de uma vez."
        aside={<Voltar href="/notas-fiscais" rotulo="Notas e Documentos" />}
        compacto
      />

      {membership.error !== null && (
        <p role="alert" className="sb-nf-aviso sb-nf-aviso-bad" style={{ marginBottom: "var(--sb-space-3)" }}>
          Não foi possível confirmar sua permissão. Recarregue a página antes de dar saída.
        </p>
      )}

      {!pode && membership.error === null && (
        <p role="note" className="sb-nf-aviso sb-nf-aviso-atencao" style={{ marginBottom: "var(--sb-space-3)" }}>
          Seu papel permite consultar, mas só ADMIN e GESTOR dão saída de estoque.
        </p>
      )}

      <SaidaManualForm desabilitado={!pode || membership.error !== null} />
    </>
  );
}
