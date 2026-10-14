/**
 * O destino de um formulário GET — o MESMO que o navegador montaria (D-500).
 *
 * O `FormularioFiltro` troca o envio nativo por `router.push`, e a troca só é
 * segura se a URL sair igual à que a recarga levava: todos os campos de texto,
 * na ordem do formulário, os vazios inclusive (`?busca=`, como o GET nativo), a
 * `?busca` antiga do `action` inteira SUBSTITUÍDA (o navegador não mescla) e
 * nenhum arquivo (GET não leva arquivo). Só caminho e busca: o destino é sempre
 * do próprio app.
 */
export function destinoDoFormulario(action: string, campos: Iterable<readonly [string, FormDataEntryValue]>): string {
  const destino = new URL(action, "http://app.local");
  const busca = new URLSearchParams();

  for (const [nome, valor] of campos) {
    if (typeof valor === "string") busca.append(nome, valor);
  }

  destino.search = busca.toString();

  return `${destino.pathname}${destino.search}`;
}
