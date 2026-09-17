import type { ReactNode } from "react";

import { Icone, type NomeDoIcone } from "../../components/icons";
import { linkEmail, linkSite, linkTelefone, linkWhatsapp, rotuloSite } from "../../lib/suppliers-overview";

/**
 * Os canais de contato do fornecedor como AÇÃO (D-366): um toque abre o
 * WhatsApp, o discador, o e-mail ou o site. Era texto corrido ("Telefone: …"),
 * que se copia à mão.
 *
 * Sem estado e sem hook: serve à lista e ao dashboard (servidor) e à gaveta
 * (cliente). Canal que não dá para interpretar continua visível como texto —
 * esconder seria perder o dado; linkar seria um link errado.
 */

export interface CanaisFornecedor {
  readonly whatsapp: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly website: string | null;
}

interface Canal {
  chave: string;
  icone: NomeDoIcone;
  rotulo: string;
  valor: string;
  href: string | null;
  externo: boolean;
}

function montarCanais(c: CanaisFornecedor): Canal[] {
  const canais: Canal[] = [];

  if (c.whatsapp !== null) {
    canais.push({
      chave: "whatsapp",
      icone: "mensagem",
      rotulo: "WhatsApp",
      valor: c.whatsapp,
      href: linkWhatsapp(c.whatsapp),
      externo: true,
    });
  }
  if (c.phone !== null) {
    canais.push({
      chave: "telefone",
      icone: "telefone",
      rotulo: "Telefone",
      valor: c.phone,
      href: linkTelefone(c.phone),
      externo: false,
    });
  }
  if (c.email !== null) {
    canais.push({
      chave: "email",
      icone: "email",
      rotulo: "E-mail",
      valor: c.email,
      href: linkEmail(c.email),
      externo: false,
    });
  }
  if (c.website !== null) {
    canais.push({
      chave: "site",
      icone: "globo",
      rotulo: "Site",
      valor: rotuloSite(c.website),
      href: linkSite(c.website),
      externo: true,
    });
  }

  return canais;
}

export function temCanal(c: CanaisFornecedor): boolean {
  return c.whatsapp !== null || c.phone !== null || c.email !== null || c.website !== null;
}

/**
 * `compacto`: só os ícones, com o valor no `title` e no nome acessível — para a
 * linha da tabela. Sem ele, cada canal mostra o valor ao lado do ícone.
 */
export function Canais({ canais, compacto = false }: { canais: CanaisFornecedor; compacto?: boolean }): ReactNode {
  const lista = montarCanais(canais);

  if (lista.length === 0) return null;

  return (
    <span className={compacto ? "sb-forn-canais sb-forn-canais-compacto" : "sb-forn-canais"}>
      {lista.map((canal) => {
        const conteudo = (
          <>
            <Icone nome={canal.icone} tamanho={compacto ? 14 : 15} />
            {!compacto && <span>{canal.valor}</span>}
          </>
        );
        const titulo = `${canal.rotulo}: ${canal.valor}`;

        return canal.href === null ? (
          <span
            key={canal.chave}
            className="sb-forn-canal sb-forn-canal-texto"
            title={`${titulo} — formato não reconhecido`}
          >
            {conteudo}
            {compacto && <span className="sb-sr-only">{titulo}</span>}
          </span>
        ) : (
          <a
            key={canal.chave}
            className={`sb-forn-canal sb-forn-canal-${canal.chave}`}
            href={canal.href}
            title={titulo}
            aria-label={compacto ? titulo : undefined}
            {...(canal.externo ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          >
            {conteudo}
          </a>
        );
      })}
    </span>
  );
}
