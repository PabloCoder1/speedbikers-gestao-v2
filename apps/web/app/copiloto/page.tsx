import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { CopilotChat } from "./chat";

export const metadata = { title: "Copiloto — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/**
 * Chat do Copiloto (Fase 7, D-114) — pergunta em linguagem natural sobre
 * vendas, respondida pelas ferramentas determinísticas de D-077 sob a RLS
 * do usuário, com streaming SSE de verdade.
 */
export default function CopilotoPage(): ReactNode {
  return (
    <Shell>
      <h1 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.375rem" }}>Copiloto</h1>

      <p style={{ margin: "0 0 var(--sb-space-4)", color: "var(--sb-text-soft)", fontSize: "0.9375rem" }}>
        Pergunte sobre vendas — por período, comparando períodos ou comparando contas. Toda resposta
        vem de consulta real, com o período e a conta sempre citados; o que as consultas não cobrem, o
        Copiloto diz que não cobre.
      </p>

      <CopilotChat />
    </Shell>
  );
}
