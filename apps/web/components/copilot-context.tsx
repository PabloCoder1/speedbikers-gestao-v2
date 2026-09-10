"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * O CONTEXTO DE TELA do Copiloto (D-294) — o que a gaveta do Figma chama de
 * "Contexto Atual".
 *
 * ## Por que um provider, e não a URL
 *
 * A gaveta vive na barra de topo, ou seja, no shell: ela não sabe em que
 * página está. Derivar o contexto da URL parece mais simples e não funciona
 * para nenhum dos dois casos reais:
 *
 *  - `/skus/[skuId]` traz o **UUID**, e a ferramenta pede o **código** do SKU
 *    (o que o operador lê e digita);
 *  - `/anuncios/[itemId]` traz o MLB, mas a ferramenta também exige a CONTA
 *    dona dele, que não está no caminho.
 *
 * Então quem sabe publica: a página renderiza um `<CopilotContextBeacon>` com
 * o que ela já tem em mãos. Página que não publica não tem contexto — e a
 * gaveta diz isso, em vez de inventar um.
 *
 * O beacon LIMPA o contexto ao desmontar. Sem isso, sair do SKU para a Home
 * deixaria a gaveta afirmando um contexto que não existe mais — que é
 * exatamente a mentira que o selo "o Copiloto lerá os dados desta tela" seria
 * se ninguém cuidasse do caso.
 */

export interface CopilotScreenContext {
  kind: "sku" | "listing";
  /** O identificador que a FERRAMENTA usa: o código do SKU, o MLB do anúncio. */
  id: string;
  /** Só para anúncio: a conta dona dele, que `listing_performance` exige. */
  mlAccountId?: string;
  /** O que a gaveta mostra ao humano ("SKU SB-001", "Anúncio MLB123"). */
  label: string;
}

interface Store {
  context: CopilotScreenContext | null;
  publish: (context: CopilotScreenContext | null) => void;
}

const CopilotContextStore = createContext<Store>({ context: null, publish: () => undefined });

export function CopilotContextProvider({ children }: { children: ReactNode }): ReactNode {
  const [context, setContext] = useState<CopilotScreenContext | null>(null);

  const publish = useCallback((next: CopilotScreenContext | null) => {
    setContext(next);
  }, []);

  const value = useMemo(() => ({ context, publish }), [context, publish]);

  return <CopilotContextStore.Provider value={value}>{children}</CopilotContextStore.Provider>;
}

export function useCopilotScreenContext(): CopilotScreenContext | null {
  return useContext(CopilotContextStore).context;
}

/**
 * O que a página renderiza para dizer onde o operador está. Não desenha nada.
 */
export function CopilotContextBeacon({ kind, id, mlAccountId, label }: CopilotScreenContext): null {
  const { publish } = useContext(CopilotContextStore);

  useEffect(() => {
    publish({ kind, id, ...(mlAccountId === undefined ? {} : { mlAccountId }), label });

    return () => {
      publish(null);
    };
  }, [kind, id, mlAccountId, label, publish]);

  return null;
}
