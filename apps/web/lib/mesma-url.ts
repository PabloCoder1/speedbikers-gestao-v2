/**
 * A MESMA URL da tela, com a `?busca` que chegou — o destino do "Tentar de
 * novo" do `EstadoDaTela` (D-502, D-468) nas telas que não têm um construtor de
 * href próprio. Repete cada parâmetro como veio, inclusive os repetidos
 * (`sku=…&sku=…` da ponte cobertura→pedido): tentar de novo é pedir a MESMA
 * leitura, não uma parecida.
 */
export function mesmaUrl(caminho: string, query: Record<string, string | string[] | undefined>): string {
  const busca = new URLSearchParams();

  for (const [chave, valor] of Object.entries(query)) {
    if (valor === undefined) continue;

    for (const item of Array.isArray(valor) ? valor : [valor]) busca.append(chave, item);
  }

  const texto = busca.toString();

  return texto === "" ? caminho : `${caminho}?${texto}`;
}
