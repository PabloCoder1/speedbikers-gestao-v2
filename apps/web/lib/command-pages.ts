/**
 * Filtro das telas na busca universal (lote 3 do pente fino, 18/09). Sem
 * acento e sem caixa: "usuarios" acha "Usuários", "estoq" acha "Estoque" e
 * "Movimentações de estoque". Procura no nome da tela e no grupo do menu; o que
 * começa com o texto vem antes do que só o contém.
 */

export interface PaginaDoMenu {
  readonly label: string;
  readonly href: string;
  readonly grupo: string;
}

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

export function filtrarPaginas(paginas: readonly PaginaDoMenu[], consulta: string, limite = 5): PaginaDoMenu[] {
  const alvo = normalizar(consulta);

  if (alvo === "") return [];

  const comeca: PaginaDoMenu[] = [];
  const contem: PaginaDoMenu[] = [];

  for (const pagina of paginas) {
    const nome = normalizar(pagina.label);

    if (nome.startsWith(alvo)) comeca.push(pagina);
    else if (nome.includes(alvo) || normalizar(pagina.grupo).includes(alvo)) contem.push(pagina);
  }

  return [...comeca, ...contem].slice(0, limite);
}
