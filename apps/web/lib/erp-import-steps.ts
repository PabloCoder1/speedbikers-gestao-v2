/**
 * As etapas de um lote de importação do UpSeller — o TERCEIRO consumidor do
 * `.process-steps` do frame (D-278, fatia D37b).
 *
 * ---------------------------------------------------------------------------
 * O MESMO CICLO DA NF-e, E UMA FRAÇÃO QUE VEM DEPOIS EM VEZ DE ANTES
 * ---------------------------------------------------------------------------
 *
 * `erp_import_batches.status` tem exatamente os mesmos sete valores de
 * `documents.status` (`UPLOADED`, `PARSING`, `PARSED`, `APPLYING`, `APPLIED`,
 * `FAILED`, `CANCELLED`), e o mesmo `parsed_at` para dizer onde uma falha
 * aconteceu. O que muda é a natureza das notas, e é aí que este consumidor
 * ensina algo que os dois anteriores não ensinavam:
 *
 *   NF-e             fração ANTES do ato   — quantos itens já têm vínculo
 *   Pedido de compra carimbo de tempo      — quando cada transição ocorreu
 *   Importação       fração DEPOIS do ato  — quanto da aplicação de fato entrou
 *
 * ---------------------------------------------------------------------------
 * O DENOMINADOR DA APLICAÇÃO É `ok_rows`, NUNCA `total_rows`
 * ---------------------------------------------------------------------------
 *
 * `apps/worker/src/handlers/erp-import-apply.ts` diz e faz: *"Só processa
 * linhas com `status = 'OK'` — o que a conferência aprovou"*, com
 * `.eq("status", "OK")` na consulta. Linha `SKIPPED` não é falha, é decisão do
 * parse; `INVALID` idem.
 *
 * Medido no Dev, e a diferença é grande num lote real: o de `LINKS` tem
 * **23.924 linhas = 20.650 OK + 3.274 ignoradas**, e aplicou **20.650**.
 * Contra `total_rows` isso viraria 86% — a tela anunciando 14% de falha num
 * lote que aplicou tudo o que devia. Contra `ok_rows`, 20.650 de 20.650.
 *
 * `unresolved_rows` é a parte que o `apply` não conseguiu resolver, e entra
 * como ressalva SÓ quando é maior que zero: escrever "0 pendentes" em todo
 * lote saudável é ruído que ensina a ignorar o aviso.
 */
import type { EtapaProcesso } from "../components/process-steps";

export function erpImportEtapas(input: {
  status: string;
  parsedAt: string | null;
  totalRows: number | null;
  okRows: number | null;
  appliedRows: number | null;
  unresolvedRows: number | null;
}): readonly EtapaProcesso[] {
  const { status, parsedAt } = input;
  const total = input.totalRows ?? 0;
  const ok = input.okRows ?? 0;
  const aplicadas = input.appliedRows ?? 0;
  const pendentes = input.unresolvedRows ?? 0;

  const leu = parsedAt !== null;
  const aplicou = status === "APPLIED";
  const aplicando = status === "APPLYING";

  // `FAILED` sem `parsed_at` quebrou lendo o arquivo; com ele, quebrou
  // aplicando — a mesma dedução de `lib/nfe-steps.ts`.
  const falhouLendo = status === "FAILED" && !leu;
  const falhouAplicando = status === "FAILED" && leu;

  const leitura: EtapaProcesso = falhouLendo
    ? { label: "Leitura da planilha", estado: "falhou" }
    : leu || aplicou || aplicando
      ? {
          label: "Leitura da planilha",
          estado: "concluida",
          nota: `${String(total)} ${total === 1 ? "linha lida" : "linhas lidas"}`,
        }
      : {
          label: "Leitura da planilha",
          estado: "atual",
          nota: status === "PARSING" ? "em andamento" : "na fila",
        };

  const conferencia: EtapaProcesso =
    aplicou || aplicando || falhouAplicando
      ? { label: "Conferência", estado: "concluida", nota: `${String(ok)} aprovadas` }
      : status === "PARSED"
        ? { label: "Conferência", estado: "atual", nota: `${String(ok)} de ${String(total)} aprovadas` }
        : { label: "Conferência", estado: "pendente" };

  const aplicacao: EtapaProcesso = falhouAplicando
    ? { label: "Aplicação", estado: "falhou" }
    : aplicou
      ? {
          label: "Aplicação",
          estado: "concluida",
          // O denominador é `ok`, e a ressalva só aparece quando existe.
          nota:
            pendentes > 0
              ? `${String(aplicadas)} de ${String(ok)} · ${String(pendentes)} pendente(s)`
              : `${String(aplicadas)} de ${String(ok)}`,
        }
      : aplicando
        ? { label: "Aplicação", estado: "atual", nota: "escrevendo no catálogo" }
        : { label: "Aplicação", estado: "pendente" };

  const etapas: readonly EtapaProcesso[] = [
    { label: "Upload da planilha", estado: "concluida" },
    leitura,
    conferencia,
    aplicacao,
  ];

  if (status !== "CANCELLED") return etapas;

  // Cancelado marca ONDE parou — a primeira que não chegou ao fim. Procurar por
  // "atual" não serviria: `CANCELLED` não é nenhum dos estados que produzem uma
  // etapa em curso (o defeito medido em D-277).
  const parou = etapas.findIndex((etapa) => etapa.estado !== "concluida");

  if (parou < 0) return etapas;

  return etapas.map((etapa, indice) =>
    indice === parou ? { label: etapa.label, estado: "cancelada" as const } : etapa,
  );
}
