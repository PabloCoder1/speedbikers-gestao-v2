import { toSalesMetricDate } from "@sb/domain";
import type { NextRequest } from "next/server";

import { currentMembership } from "../../../../lib/membership";
import { resolvePeriodRange } from "../../../../lib/period";
import { TETO_DA_SERIE, lerSerieDiaria } from "../../../../lib/serie-de-vendas";
import { createClient } from "../../../../lib/supabase/server";
import { contasParaCsv, diasParaCsv } from "../../../../lib/vendas-export";
import { marketplacesDoEscopo, resolverContas, resolverEscopoDaTelaDeVendas } from "../../../../lib/vendas-multicanal";

/**
 * CSV de `/vendas` no "Todos" e na "Shopee" (D-496): a MESMA URL da tela, lida
 * pelos mesmos resolvedores (marketplace, período e contas), e as MESMAS RPCs do
 * C-53 — `tabela=dia` é a série do gráfico; `tabela=conta`, a tabela "Por
 * marketplace e conta".
 *
 * O recorte do Mercado Livre fica de fora: a tela dele tem filtros que o C-53
 * não conhece (marca, conta única, pacotes), e o CSV divergiria do que se vê.
 *
 * Sessão do usuário e RPCs `security invoker`: a planilha vê só as contas e
 * lojas que a pessoa alcança. A série é lida em páginas com ordem estável (o
 * período personalizado não tem teto, e o `max_rows` cortaria em silêncio);
 * passou do teto, a resposta diz, em vez de cortar (D-131).
 */
export async function GET(request: NextRequest): Promise<Response> {
  const query = Object.fromEntries(request.nextUrl.searchParams.entries());
  const tabela = query.tabela;

  if (tabela !== "dia" && tabela !== "conta") {
    return new Response("Escolha a tabela: tabela=dia ou tabela=conta.", { status: 400 });
  }

  const escopo = resolverEscopoDaTelaDeVendas(query);

  if (escopo === "ml") {
    return new Response('O CSV de vendas cobre o recorte "Todos" e o da Shopee; o do Mercado Livre ainda não exporta.', {
      status: 400,
    });
  }

  const supabase = await createClient();
  const [membership, contasResult] = await Promise.all([
    currentMembership(supabase),
    supabase.from("marketplace_accounts").select("account_id, marketplace, name, environment"),
  ]);

  if (membership.organizationId === null) {
    return new Response("Sua conta não está associada a nenhuma organização.", { status: 403 });
  }

  // Sem as contas, um recorte de contas viraria "todas" em silêncio.
  if (contasResult.error !== null) {
    return new Response(`Não foi possível ler as contas: ${contasResult.error.message}`, { status: 502 });
  }

  const { range } = resolvePeriodRange(query, toSalesMetricDate(new Date()));
  const { selecionadas } = resolverContas(query.contas, contasResult.data, escopo);
  const argumentos = {
    p_organization_id: membership.organizationId,
    p_marketplaces: marketplacesDoEscopo(escopo),
    p_account_ids: selecionadas === null ? null : selecionadas.map((conta) => conta.account_id),
    p_date_from: range.from,
    p_date_to: range.to,
  };
  const base = `vendas-${escopo}-${range.from}-a-${range.to}`;

  if (tabela === "conta") {
    // Uma linha por conta e loja, mais as somas: poucas linhas, sem página.
    const resumo = await supabase.rpc("get_marketplace_sales_summary", argumentos);

    if (resumo.error !== null) {
      return new Response(`Não foi possível exportar as vendas por conta: ${resumo.error.message}`, { status: 502 });
    }

    return csv(contasParaCsv(resumo.data, escopo), `${base}-por-conta.csv`);
  }

  // A mesma leitura em páginas do gráfico (`lerSerieDiaria`): o arquivo e a tela não divergem.
  const { linhas, error } = await lerSerieDiaria(supabase, argumentos);

  if (error !== null) {
    return new Response(`Não foi possível exportar as vendas por dia: ${error.message}`, { status: 502 });
  }

  if (linhas.length >= TETO_DA_SERIE) {
    return new Response(`O período passa de ${String(TETO_DA_SERIE)} linhas por dia e marketplace; exporte um período menor.`, {
      status: 422,
    });
  }

  return csv(diasParaCsv(linhas, escopo), `${base}-por-dia.csv`);
}

function csv(corpo: string, nome: string): Response {
  return new Response(corpo, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${nome}"`,
      "Cache-Control": "no-store",
    },
  });
}
