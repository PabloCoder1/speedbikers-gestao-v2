/** Campo de número em pt-BR: aceita "189,90" e "189.90"; vazio é `null`, nunca zero. */
export function lerNumero(texto: string): number | null {
  const bruto = texto.trim();

  if (bruto === "") return null;

  // Com vírgula, o ponto é milhar ("1.234,56"); sem vírgula, o ponto é decimal ("189.90").
  const valor = Number(bruto.includes(",") ? bruto.replace(/\./g, "").replace(",", ".") : bruto);

  return Number.isFinite(valor) ? valor : null;
}
