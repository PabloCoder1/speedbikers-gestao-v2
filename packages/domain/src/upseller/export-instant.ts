/**
 * O instante em que a planilha de estoque do UpSeller foi EXPORTADA (D-351).
 *
 * **Por que importa.** O saldo da `Lista_de_Estoque` e o Disponivel do ERP no
 * instante da exportacao, e o UpSeller puxa o pedido do Mercado Livre na hora
 * (resposta do dono em 2026-09-14). Esse instante e o CORTE do snapshot: venda
 * anterior a ele ja esta descontada na planilha, venda posterior nao. Ate D-351
 * o corte gravado era o instante do PARSE (`erp_import_batches.parsed_at`) —
 * em producao, 2 min 13 s depois da exportacao; no Dev, 23 h 33 min depois.
 * Toda venda dessa janela era tratada como "ja na planilha" sem estar.
 *
 * **De onde vem.** Do nome do arquivo que o UpSeller gera:
 * `Lista_de_Estoque_MMDDHHMMSS.xlsx`, em UTC. Conferido nos dois bancos: o
 * lote de producao `Lista_de_Estoque_0914184200.xlsx` foi enviado as 18:44:11
 * UTC (em BRT seria 21:42 UTC, depois do envio — impossivel), e o do Dev,
 * `Lista_de_Estoque_0820160923.xlsx`, casa com o segundo carimbo dos outros
 * tres arquivos da mesma exportacao (`..._202608201308-20260820160836...`:
 * o primeiro e BRT, o segundo e UTC). Os outros tres arquivos nao entram aqui
 * — so o de estoque vira snapshot.
 *
 * **O ano nao vem no nome.** Entre os anos vizinhos ao do parse, fica o
 * candidato mais proximo do parse — assim um relogio adiantado de minutos no
 * ERP nao empurra a data um ano para tras, e a virada de ano cai no ano certo.
 *
 * **Limites.** O resultado fica em `[parsedAt - 24 h, parsedAt]`: exportacao
 * nao acontece depois do parse, e um nome que aponte para mais de um dia antes
 * e tratado como o limite, nao como verdade. Nome sem o padrao, ou com data
 * impossivel (mes 13, 30 de fevereiro), cai em `parsedAt` — o comportamento de
 * antes de D-351.
 *
 * **Tem um gemeo em SQL**, `private.erp_stock_export_instant`, que a migration
 * de D-351 usou para corrigir os snapshots ja gravados. A integracao compara os
 * dois caso a caso (`estoque-pre-captura.integration.test.ts`): se um mudar
 * sem o outro, o corte do worker e o do banco divergem.
 */

const PADRAO = /Lista_de_Estoque_(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?!\d)/;

const UM_DIA_MS = 24 * 60 * 60 * 1000;

export function resolveStockExportInstant(fileName: string | null, parsedAt: Date): Date {
  const casamento = fileName === null ? null : PADRAO.exec(fileName);

  if (casamento === null) {
    return parsedAt;
  }

  const [mes, dia, hora, minuto, segundo] = casamento.slice(1).map(Number) as [number, number, number, number, number];

  if (mes < 1 || mes > 12 || dia < 1 || hora > 23 || minuto > 59 || segundo > 59) {
    return parsedAt;
  }

  const anoDoParse = parsedAt.getUTCFullYear();
  let melhor: Date | null = null;

  for (const ano of [anoDoParse - 1, anoDoParse, anoDoParse + 1]) {
    const candidato = new Date(Date.UTC(ano, mes - 1, dia, hora, minuto, segundo));

    // `Date.UTC` normaliza o que transborda (30/02 vira 02/03): a volta pelo
    // mesmo campo e o que distingue data real de data impossivel NAQUELE ano.
    if (candidato.getUTCMonth() !== mes - 1 || candidato.getUTCDate() !== dia) {
      continue;
    }

    if (
      melhor === null ||
      Math.abs(candidato.getTime() - parsedAt.getTime()) < Math.abs(melhor.getTime() - parsedAt.getTime())
    ) {
      melhor = candidato;
    }
  }

  if (melhor === null) {
    return parsedAt;
  }

  const teto = parsedAt.getTime();
  const piso = teto - UM_DIA_MS;

  return new Date(Math.max(Math.min(melhor.getTime(), teto), piso));
}
