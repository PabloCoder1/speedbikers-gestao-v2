/** Erro compartilhado pelas ferramentas, sem importar o orquestrador. */
export class CopilotToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopilotToolError";
  }
}
