import type { ReactNode } from "react";

import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
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
      <PageTitle
        eyebrow="INTELIGÊNCIA / COPILOTO"
        title="Copiloto"
        subtitle="Respostas operacionais sobre vendas, estoque e anúncios, sempre baseadas em consultas reais e no acesso do usuário."
      />

      {/*
        O FRAME NÃO TEM ESTA TELA. O Copiloto dele é uma GAVETA de 420px à
        direita, aberta de qualquer página por um botão flutuante — e o grupo
        de Administração do desenho termina em Configurações, sem entrada para
        Copiloto.

        A gaveta não entra nesta fatia, e o motivo é o que ela promete: o selo
        "Contexto Atual" e a frase "o Copiloto lerá os dados desta tela" fazem
        do contexto o coração dela, e `/v1/copilot/chat` recebe UMA mensagem,
        sem parâmetro de tela. Fazer a gaveta hoje seria construir a moldura da
        ideia e chamar de pronto — a medição completa está em D-276.
      */}
      <Panel
        title="Conversa com dados reais"
        subtitle="Pergunte sobre vendas por período, compare contas ou informe um SKU/anúncio para consultar reposição e desempenho. Cada pergunta é independente: não há histórico entre uma e outra e nada fica salvo."
      >
        <div className="sb-panel-body sb-copilot-panel-body">
          <div className="sb-copilot-contract" role="note">
            <span className="sb-copilot-contract-mark" aria-hidden="true">✦</span>
            <div>
              <strong>O que você pode esperar</strong>
              <p>O Copiloto consulta dados autorizados da operação e mostra quais fontes usou. Quando não houver cobertura, ele informa — sem transformar ausência em zero.</p>
            </div>
          </div>
          <CopilotChat />
        </div>
      </Panel>
    </Shell>
  );
}
