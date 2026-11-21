const DECIMAL_COM_VIRGULA = /^[+-]?(?:(?:\d+|\d{1,3}(?:\.\d{3})+),\d*|,\d+)$/;
const DECIMAL_COM_PONTO = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/** Campo de número em pt-BR: aceita "189,90" e "189.90"; vazio é `null`, nunca zero. */
export function lerNumero(texto: string): number | null {
  const bruto = texto.trim();
  const temVirgula = bruto.includes(",");
  const formato = temVirgula ? DECIMAL_COM_VIRGULA : DECIMAL_COM_PONTO;

  if (!formato.test(bruto)) return null;

  // Com vírgula, o ponto é milhar ("1.234,56"); sem vírgula, o ponto é decimal ("189.90").
  const valor = Number(temVirgula ? bruto.replaceAll(".", "").replace(",", ".") : bruto);

  return Number.isFinite(valor) ? valor : null;
}
