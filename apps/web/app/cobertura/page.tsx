import { permanentRedirect } from "next/navigation";

/**
 * `/cobertura` FOI FUNDIDA em `/reposicao` (D-288).
 *
 * O frame trata as duas como UMA tela desde sempre (D-261), e a fusão exigia
 * escolher uma definição de ruptura: as duas discordavam em **186 SKUs** porque
 * mediam coisas diferentes — estoque LOCAL sobre 30 dias contra
 * local + Full + trânsito com lead time e cobertura alvo. **A escolha do
 * usuário foi a da reposição**, e o número que a sustenta é este: das 325 que a
 * cobertura chamava de ruptura, **150 tinham Full ou trânsito** — saldo que
 * existe, só não estava na prateleira que ela olhava.
 *
 * A rota sobrevive só para não quebrar link antigo: `permanentRedirect` (308)
 * preserva o método e diz ao navegador e ao histórico que o destino mudou. O
 * recorte de marca viaja junto — quem tinha `/cobertura?marca=X` salvo nos
 * Filtros Salvos chega em `/reposicao?marca=X`.
 */
export default async function CoberturaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<never> {
  const marca = (await searchParams).marca;
  const recorte = typeof marca === "string" && marca !== "" ? `?marca=${encodeURIComponent(marca)}` : "";

  permanentRedirect(`/reposicao${recorte}`);
}
