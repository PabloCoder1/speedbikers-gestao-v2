"use client";

import { useState, type ReactNode } from "react";

/**
 * O LINK, com o aviso que ele exige (D-303).
 *
 * Nasceu dentro de `convidar.tsx` (D-296) e virou componente quando apareceu o
 * segundo consumidor — a reemissão na gaveta —, que é a regra desta casa:
 * extrair na segunda cópia, não na primeira nem na décima.
 *
 * **O aviso não é enfeite.** Quem abrir o link define a senha daquela conta:
 * ele vale como senha, aparece uma vez e não fica guardado em tela nenhuma.
 */
export function LinkDeAcesso({ link }: { link: string }): ReactNode {
  const [copiado, setCopiado] = useState(false);

  return (
    <div style={{ display: "grid", gap: "var(--sb-space-2)" }}>
      <p className="sb-note sb-note-atencao" style={{ margin: 0 }}>
        <span>Trate como senha</span>
        <span
          style={{
            display: "block",
            fontFamily: "var(--sb-sans)",
            fontSize: "0.6875rem",
            marginTop: "0.375rem",
          }}
        >
          Quem abrir este link define a senha da conta. Ele aparece uma vez só e não fica guardado
          nesta tela.
        </span>
      </p>

      <textarea className="sb-input sb-input-full" readOnly rows={3} value={link} />

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          className="sb-button"
          onClick={() => {
            void navigator.clipboard.writeText(link).then(() => {
              setCopiado(true);
            });
          }}
        >
          {copiado ? "Copiado" : "Copiar link"}
        </button>
      </div>
    </div>
  );
}
