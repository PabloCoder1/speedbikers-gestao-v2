"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * O AVISO DE "SALVO" da configuração (D-361).
 *
 * Não pode morar no botão que abriu a gaveta: o botão "Definir o padrão da
 * organização" vive na seção de primeiros passos, que SOME exatamente quando o
 * padrão é criado — a confirmação desapareceria junto com a seção. Este
 * componente fica montado no topo da página, fora de tudo que o salvamento
 * redesenha, e escuta um evento do documento.
 *
 * Evento e não contexto: as gavetas são ilhas de cliente espalhadas por uma
 * página de servidor, e um provider em volta delas obrigaria a página inteira a
 * atravessar uma fronteira de cliente só para levar uma frase.
 */

const EVENTO = "sb-cfg-aviso";

export function avisar(mensagem: string): void {
  window.dispatchEvent(new CustomEvent<string>(EVENTO, { detail: mensagem }));
}

export function AvisoDaConfiguracao(): ReactNode {
  const [mensagem, setMensagem] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    function ouvir(evento: Event): void {
      if (!(evento instanceof CustomEvent) || typeof evento.detail !== "string") return;

      setMensagem(evento.detail);

      if (timer !== null) clearTimeout(timer);
      // Tempo para ler uma frase curta; quem precisa de mais tem a página, que
      // já mostra a regra salva.
      timer = setTimeout(() => {
        setMensagem(null);
      }, 5000);
    }

    window.addEventListener(EVENTO, ouvir);

    return () => {
      window.removeEventListener(EVENTO, ouvir);
      if (timer !== null) clearTimeout(timer);
    };
  }, []);

  // A região existe sempre (vazia quando não há aviso): leitor de tela só
  // anuncia mudança numa região viva que já estava no documento.
  return (
    <div role="status" aria-live="polite" className={mensagem === null ? "sb-cfg-aviso" : "sb-cfg-aviso sb-cfg-aviso-visivel"}>
      {mensagem !== null && <>✓ {mensagem}</>}
    </div>
  );
}
