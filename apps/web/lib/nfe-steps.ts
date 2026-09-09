/**
 * As etapas da NF-e — o `.process-steps` do frame, mapeado contra os estados
 * que o sistema REALMENTE tem (D-277, fatia D37).
 *
 * ---------------------------------------------------------------------------
 * SEIS ETAPAS NO FRAME, QUATRO ESTADOS NO BANCO
 * ---------------------------------------------------------------------------
 *
 * O frame desenha seis passos:
 *
 *   1 Upload XML · 2 Processando · 3 Itens encontrados · 4 Vinculação ·
 *   5 Conferência · 6 Confirmar entrada
 *
 * `documents.status` tem sete valores (`documents_status_check`), e o caminho
 * feliz são cinco: UPLOADED, PARSING, PARSED, APPLYING, APPLIED — mais FAILED
 * e CANCELLED, que saem do trilho.
 *
 * **Os passos 3, 4 e 5 do frame são o MESMO estado: `PARSED`.** "Itens
 * encontrados", "Vinculação" e "Conferência" não são três momentos que o
 * sistema distingue — são três nomes para o intervalo entre o parse terminar e
 * o humano confirmar. Desenhar os seis acenderia e apagaria bolinhas que nada
 * mede: a barra andaria de 3 para 5 sem que nada tivesse acontecido, ou
 * ficaria parada no 3 com o trabalho todo feito. Progresso inventado é pior do
 * que progresso ausente, porque parece informação.
 *
 * Ficam QUATRO, uma por estado real, e a fração que o frame não tem entra como
 * nota da terceira: `resolved_items de total_items` é o único progresso
 * mensurável dentro de `PARSED`, e é justamente o que o frame tentava
 * representar com três bolinhas.
 *
 * ---------------------------------------------------------------------------
 * FALHA TEM LUGAR, E O LUGAR É DEDUZÍVEL
 * ---------------------------------------------------------------------------
 *
 * `FAILED` não diz ONDE quebrou, mas `parsed_at` diz: sem ele, a leitura do
 * arquivo não chegou ao fim; com ele, o que falhou foi a aplicação. Um
 * indicador de processo que mostra o caminho feliz quando o documento está
 * `FAILED` é a classe de mentira que este projeto persegue.
 *
 * `CANCELLED` é terminal e não tem etapa "atual" — mas tem um LUGAR. A etapa
 * onde o documento parou fica marcada como cancelada em vez de voltar a
 * pendente: rebaixá-la apagaria justamente o que interessa saber.
 */
import type { EtapaProcesso } from "../components/process-steps";

export function nfeEtapas(input: {
  status: string;
  parsedAt: string | null;
  totalItems: number | null;
  resolvedItems: number | null;
}): readonly EtapaProcesso[] {
  const { status, parsedAt } = input;
  const total = input.totalItems ?? 0;
  const vinculados = input.resolvedItems ?? 0;

  const leu = parsedAt !== null;
  const aplicou = status === "APPLIED";
  const aplicando = status === "APPLYING";

  // FAILED sem `parsed_at` quebrou lendo o arquivo; com ele, quebrou aplicando.
  const falhouLendo = status === "FAILED" && !leu;
  const falhouAplicando = status === "FAILED" && leu;

  const leitura: EtapaProcesso = falhouLendo
    ? { label: "Leitura do arquivo", estado: "falhou" }
    : leu || aplicou || aplicando
      ? { label: "Leitura do arquivo", estado: "concluida" }
      : {
          label: "Leitura do arquivo",
          estado: "atual",
          nota: status === "PARSING" ? "em andamento" : "na fila",
        };

  const conferencia: EtapaProcesso =
    aplicou || aplicando || falhouAplicando
      ? {
          label: "Conferência e vínculo",
          estado: "concluida",
          // A aplicação só é aceita com 100% vinculado (`confirmNfeApply`) —
          // daí o total sozinho dizer tudo depois que ela começa.
          nota: `${String(total)} ${total === 1 ? "item vinculado" : "itens vinculados"}`,
        }
      : status === "PARSED"
        ? {
            label: "Conferência e vínculo",
            estado: "atual",
            nota: `${String(vinculados)} de ${String(total)} vinculados`,
          }
        : { label: "Conferência e vínculo", estado: "pendente" };

  const entrada: EtapaProcesso = falhouAplicando
    ? { label: "Entrada no estoque", estado: "falhou" }
    : aplicou
      ? { label: "Entrada no estoque", estado: "concluida" }
      : aplicando
        ? { label: "Entrada no estoque", estado: "atual", nota: "gerando os movimentos" }
        : { label: "Entrada no estoque", estado: "pendente" };

  // O documento existe porque o arquivo chegou: a primeira etapa nunca está
  // pendente nesta tela.
  const etapas: readonly EtapaProcesso[] = [
    { label: "Upload do XML", estado: "concluida" },
    leitura,
    conferencia,
    entrada,
  ];

  if (status !== "CANCELLED") return etapas;

  // Cancelado não tem etapa em curso, mas tem um LUGAR: a PRIMEIRA que não
  // chegou ao fim é onde parou. Procurar por "atual" não serviria — `CANCELLED`
  // não é `PARSED`, então nenhuma etapa chega aqui marcada como em curso, e o
  // resultado seria um cancelamento sem lugar nenhum.
  const parou = etapas.findIndex((etapa) => etapa.estado !== "concluida");

  if (parou < 0) return etapas;

  return etapas.map((etapa, indice) =>
    indice === parou ? { label: etapa.label, estado: "cancelada" as const } : etapa,
  );
}
