import { toSalesMetricDate } from "@sb/domain";
import type { NextRequest } from "next/server";

import { currentMembership } from "../../../../lib/membership";
import { resolvePeriodRange } from "../../../../lib/period";
import { TETO_DA_SERIE, lerSerieDiaria, lerSerieDoMl } from "../../../../lib/serie-de-vendas";
import { createClient } from "../../../../lib/supabase/server";
import { contasParaCsv, diasDoMlParaCsv, diasParaCsv } from "../../../../lib/vendas-export";
import { argumentosDaMarca, resolverContaDaVenda, resolverMarcaDaVenda, type FiltroDeMarca } from "../../../../lib/vendas-ml-filtros";
import { marketplacesDoEscopo, resolverContas, resolverEscopoDaTelaDeVendas } from "../../../../lib/vendas-multicanal";

/**
 * CSV de `/vendas` no "Todos" e na "Shopee" (D-496): a MESMA URL da tela, lida
 * pelos mesmos resolvedores (marketplace, período e contas), e as MESMAS RPCs do
 * C-53 — `tabela=dia` é a série do gráfico; `tabela=conta`, a tabela "Por
 * marketplace e conta".
 *
 * O recorte do Mercado Livre (D-602) exporta pela leitura da PRÓPRIA tela dele
 * (`get_sales_daily_series`, com a conta e a marca), e não pelo C-53, que não
 * conhece esses filtros: o CSV nunca diverge do que se vê. Ele tem a série por
 * dia; a tabela por conta é do "Todos" e da Shopee.
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
    return tabela === "dia"
      ? exportarDiasDoMl(query)
      : new Response('O recorte do Mercado Livre exporta a série por dia; a tabela por conta é a do "Todos" e a da Shopee.', {
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
  // D-622: a marca da tela, pelo mesmo resolvedor, e só com valor (C-72). Sem ela o arquivo contradiria a tela.
  const marca = resolverMarcaDaVenda(query);
  const argumentos = {
    p_organization_id: membership.organizationId,
    p_marketplaces: marketplacesDoEscopo(escopo),
    p_account_ids: selecionadas === null ? null : selecionadas.map((conta) => conta.account_id),
    p_date_from: range.from,
    p_date_to: range.to,
    ...argumentosDaMarca(marca),
  };
  const base = [`vendas-${escopo}-${range.from}-a-${range.to}`, trechoDaMarca(marca)].filter((trecho) => trecho !== null).join("-");

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

/** Só letras, números e hífen no nome do arquivo: a marca vem da URL e iria para o cabeçalho da resposta. */
function trechoDoNome(valor: string): string {
  return valor
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

/** O trecho da marca no nome do arquivo, o mesmo nos três recortes (D-602, D-622). */
function trechoDaMarca(marca: FiltroDeMarca): string | null {
  if (marca.kind === "marca") return `marca-${trechoDoNome(marca.value)}`;

  return marca.kind === "sem_marca" ? "sem-marca" : null;
}

/** D-602: a série por dia do recorte do ML, pelos MESMOS resolvedores e a MESMA leitura da tela dele. */
async function exportarDiasDoMl(query: Readonly<Record<string, string>>): Promise<Response> {
  const supabase = await createClient();
  const [membership, contas] = await Promise.all([currentMembership(supabase), supabase.from("ml_accounts").select("id, slug")]);

  if (membership.organizationId === null) {
    return new Response("Sua conta não está associada a nenhuma organização.", { status: 403 });
  }

  // Sem as contas, um recorte de conta viraria "todas" em silêncio.
  if (contas.error !== null) {
    return new Response(`Não foi possível ler as contas: ${contas.error.message}`, { status: 502 });
  }

  const { range } = resolvePeriodRange(query, toSalesMetricDate(new Date()));
  const conta = resolverContaDaVenda(query, contas.data);
  const marca = resolverMarcaDaVenda(query);
  const { data, error } = await lerSerieDoMl(supabase, {
    p_date_from: range.from,
    p_date_to: range.to,
    ...(conta === null ? {} : { p_ml_account_id: conta.id }),
    ...argumentosDaMarca(marca),
  });

  if (error !== null) {
    return new Response(`Não foi possível exportar as vendas por dia: ${error.message}`, { status: 502 });
  }

  if (data.length >= TETO_DA_SERIE) {
    return new Response(`O período passa de ${String(TETO_DA_SERIE)} dias; exporte um período menor.`, { status: 422 });
  }

  const recorte = [conta === null ? null : trechoDoNome(conta.slug), trechoDaMarca(marca)].filter((trecho): trecho is string => trecho !== null && trecho !== "");
  const nome = [`vendas-ml-${range.from}-a-${range.to}`, ...recorte, "por-dia"].join("-");

  return csv(diasDoMlParaCsv(data), `${nome}.csv`);
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
