import type { ReactNode } from "react";

import { TOM } from "../../../components/tone";

/** O que o selo lê da curva: a linha do SKU, ou a falha (inclusive a de quem lançou). */
export interface LeituraCurvaAbc {
  readonly data: { readonly abc_class: string | null } | null;
  readonly error: unknown;
}

/**
 * O selo "Curva A/B/C" do cabeçalho do SKU (D-247), que chega DEPOIS do resto
 * da tela (D-505).
 *
 * A curva é a leitura mais cara da página — ordena 90 dias da organização
 * inteira para dar a posição de um SKU, ~5,4 mil páginas frias medidas pelo A1
 * (D-461) — e alimenta só este rótulo. Dentro do `Promise.all`, ela definia o
 * piso de TODAS as abas. Aqui, só o selo espera; o lugar dele fica reservado
 * pelo `SeloCarregando`.
 *
 * Falha ou SKU sem venda no período: NENHUM selo. Um SKU fora da curva não é
 * "classe C" — ele não foi classificado, e afirmar C seria inventar posição.
 */
export async function SeloCurvaAbc({ leitura }: { leitura: Promise<LeituraCurvaAbc> }): Promise<ReactNode> {
  const { data, error } = await leitura;
  const classe = error === null ? (data?.abc_class ?? null) : null;

  if (classe === null) return null;

  // Como no frame ("Curva A"): A é o que sustenta a receita, e por isso leva o
  // tom de atenção; B e C ficam neutros.
  return (
    <span className="sb-status" style={TOM[classe === "A" ? "atencao" : "neutro"]}>
      {`Curva ${classe}`}
    </span>
  );
}
