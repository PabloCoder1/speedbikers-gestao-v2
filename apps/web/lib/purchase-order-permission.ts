/**
 * Quem opera pedido de compra: o MESMO corte de `private.check_purchase_order_writer`
 * (ADMIN ou GESTOR), que todas as RPCs de escrita de pedido chamam — criar,
 * editar rascunho, aprovar, marcar enviado, receber e cancelar.
 *
 * A tela só usa isto para NÃO OFERECER o que o banco vai recusar (lote 1 do
 * pente fino, 18/09): antes, qualquer papel preenchia o pedido inteiro e só
 * descobria no "Salvar". A defesa continua no banco.
 */
export function podeOperarCompras(role: string | null): boolean {
  return role === "ADMIN" || role === "GESTOR";
}
