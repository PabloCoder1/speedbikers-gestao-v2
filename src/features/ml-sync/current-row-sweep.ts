/*
 * Varredura de linhas obsoletas.
 *
 * Pedidos e anúncios guardam linhas filhas (itens do pedido, variações
 * do anúncio) marcadas com `is_current`. A cada sincronização, as linhas
 * recebidas são regravadas com o `last_seen_sync_run_id` da execução
 * atual; as que não vieram precisam sair de `is_current`.
 *
 * O alvo da varredura é sempre a lista de PAIS processados nesta
 * execução, nunca a lista de filhos recebidos. Decidir pelo número de
 * filhos faz o caso mais importante escapar: quando um pedido perde uma
 * linha ou um anúncio deixa de ter variações, a resposta chega com zero
 * filhos e é exatamente aí que a linha antiga precisa ser invalidada.
 */
export function sweepTargets(
  ids: Iterable<string | null | undefined>,
): string[] {
  const targets = new Set<string>();

  for (const id of ids) {
    if (typeof id === "string" && id.length > 0) {
      targets.add(id);
    }
  }

  return Array.from(targets);
}
