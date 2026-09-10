import type { Tom } from "../components/tone";

/**
 * O tom do selo de PAPEL, como o frame pinta a coluna "Papel (Organização)":
 * ADMIN em perigo, GESTOR em atenção, o resto em info (D-297).
 *
 * Perigo aqui não é "coisa errada" — é ALCANCE: ADMIN muda permissão dos
 * outros, e o frame usa a cor mais forte para dizer isso de longe. É a mesma
 * razão pela qual a faixa de indicadores já marcava a célula de ADMIN.
 *
 * **Mora fora das duas telas porque nasceu com dois leitores** — a tabela e a
 * gaveta —, e um mapa de tom duplicado é exatamente o que D-246 encontrou cinco
 * vezes antes de `components/tone.ts` existir. O segundo é sempre o que sai de
 * sincronia.
 */
export function tomDePapel(role: string): Tom {
  if (role === "ADMIN") return "perigo";
  if (role === "GESTOR") return "atencao";

  return "info";
}
