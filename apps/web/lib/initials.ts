/**
 * O MONOGRAMA de uma pessoa ou organização — as letras do avatar.
 *
 * Nasceu privado em `components/shell.tsx` (avatar do perfil e da marca) e saiu
 * para cá quando ganhou o segundo e o terceiro consumidores de uma vez (A12,
 * D-320): o autor de cada decisão no painel "Últimas decisões" do SKU, e a
 * gaveta de `/usuarios`, que calculava a SUA versão — uma letra só, por
 * `charAt(0)`. Duas regras para o mesmo desenho é a divergência que D-246 pagou
 * cinco vezes com mapas de tom; o frame desenha "JM" nos três lugares.
 *
 * Duas letras no máximo: a primeira de cada uma das duas primeiras partes. O
 * separador inclui `@`, `.`, `_` e `-` porque o rótulo de reserva, quando o
 * perfil não tem nome, é o e-mail — e "joao.martins@loja" vira "JM", não "J".
 *
 * Texto vazio devolve `?`: o avatar é um círculo com letra, e um círculo vazio
 * leria como defeito de carregamento em vez de "não sabemos quem é".
 */
export function iniciais(texto: string): string {
  const limpo = texto.trim();

  if (limpo === "") return "?";

  const partes = limpo.split(/[\s@._-]+/).filter((parte) => parte !== "");
  const letras = partes.slice(0, 2).map((parte) => parte.charAt(0));

  return letras.join("").toUpperCase() || limpo.charAt(0).toUpperCase();
}

/**
 * O MONOGRAMA de um PRODUTO — as letras do `.product-thumb` do frame ("XR",
 * "PF", "CB"), no lugar onde a foto estaria.
 *
 * É OUTRA regra, e de propósito. Nasceu privada em `app/anuncios/page.tsx` e
 * saiu para cá quando a gaveta do pedido (A13, D-321) virou o segundo
 * consumidor. Título de produto não é nome de gente: "Kit Relação E2E — vende e
 * tem visita" tem travessão e código, então só contam as palavras que têm LETRA;
 * e um título de uma palavra devolve as DUAS primeiras letras dela ("Guidão" →
 * "Gu"), onde `iniciais` devolveria uma. Sai do próprio título, então é sempre
 * verdade sobre o produto da linha.
 *
 * Título vazio não existe (`listings.title` e `order_items.title` não são
 * nulos), mas se existisse cairia em "—". A caixa alta é do CSS.
 */
export function monogramaDeProduto(titulo: string): string {
  const palavras = titulo.trim().split(/\s+/).filter((p) => /\p{L}/u.test(p));

  if (palavras.length === 0) {
    return "—";
  }

  if (palavras.length === 1) {
    return (palavras[0] ?? "").slice(0, 2);
  }

  return `${(palavras[0] ?? "").slice(0, 1)}${(palavras[1] ?? "").slice(0, 1)}`;
}
