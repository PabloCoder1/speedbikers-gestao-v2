import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { EstadoDaTela, TENTAR_DE_NOVO } from "../../../../../components/estado-da-tela";
import { PageTitle } from "../../../../../components/page-title";
import { Panel } from "../../../../../components/panel";
import { Voltar } from "../../../../../components/voltar";
import { formatCount, formatDateTime } from "../../../../../lib/format";
import { podeOperarCompras } from "../../../../../lib/purchase-order-permission";
import { currentMembership } from "../../../../../lib/request-membership";
import { createClient } from "../../../../../lib/supabase/server";
import { GrupoRegistro, LinhaConferencia, type GrupoLote, type LinhaLote } from "./conferencia";

export const metadata = { title: "Conferir importação — Speed Bikers Gestão" };
export const dynamic = "force-dynamic";

/**
 * Etapas B a E da importação (D-764): o vínculo ao catálogo (feito no banco),
 * a conferência das linhas, a pré-visualização por referência e a gravação.
 * Uma referência vira UM pedido, com a situação que o usuário escolhe —
 * nunca "pedido realizado" por padrão. Linha não vinculada fica salva aqui
 * para conciliar depois.
 */

const FILTROS = {
  PENDENTES: "A conferir",
  AMBIGUAS: "Ambíguas",
  NAO_ENCONTRADAS: "Não encontradas",
  QUANTIDADE: "Quantidade a confirmar",
  SEM_REFERENCIA: "Sem referência",
  VINCULADAS: "Vinculadas",
  JA_NO_PEDIDO: "Já no pedido",
  REGISTRADAS: "Registradas",
  IGNORADAS: "Ignoradas",
} as const;

const POR_PAGINA = 200;

interface Lote {
  lote: { id: string; fileName: string; sheetNames: string[]; rowCount: number; createdAt: string; createdBy: string | null };
  resumo: Record<string, number>;
  grupos: GrupoLote[];
  total: number;
  linhas: LinhaLote[];
}

export default async function LoteImportacaoPage({
  params,
  searchParams,
}: {
  params: Promise<{ loteId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { loteId } = await params;
  const query = await searchParams;
  const filtroBruto = typeof query.filtro === "string" ? query.filtro : null;
  const filtro = filtroBruto !== null && filtroBruto in FILTROS ? (filtroBruto as keyof typeof FILTROS) : null;
  const pagina = Math.max(1, Number(typeof query.pagina === "string" ? query.pagina : "1") || 1);
  const membership = await currentMembership();

  if (membership.organizationId === null || !podeOperarCompras(membership.role)) notFound();

  const supabase = await createClient();
  const [lote, fornecedores] = await Promise.all([
    supabase.rpc("get_purchase_import_batch", {
      p_batch_id: loteId,
      ...(filtro === null ? {} : { p_filtro: filtro }),
      p_limit: POR_PAGINA,
      p_offset: (pagina - 1) * POR_PAGINA,
    }),
    supabase.from("suppliers").select("id, name").eq("is_active", true).order("name").limit(500),
  ]);

  if (lote.error !== null) {
    return (
      <>
        <PageTitle eyebrow="ESTOQUE / OPERAÇÃO" title="Conferir importação" aside={<Voltar href="/compras/importar" rotulo="Importações" />} />
        <EstadoDaTela
          tipo="erro"
          titulo="Não foi possível carregar a importação"
          detalhe={lote.error.message}
          acao={{ href: `/compras/importar/${loteId}`, rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
        />
      </>
    );
  }

  if (lote.data === null) notFound();

  const d = lote.data as unknown as Lote;
  const r = d.resumo;
  const totalPaginas = Math.max(1, Math.ceil(d.total / POR_PAGINA));
  const href = (f: string | null, p = 1): string => {
    const q = new URLSearchParams();

    if (f !== null) q.set("filtro", f);
    if (p > 1) q.set("pagina", String(p));

    const s = q.toString();

    return `/compras/importar/${loteId}${s === "" ? "" : `?${s}`}`;
  };
  const existente = query.existente === "1";

  return (
    <>
      <PageTitle
        eyebrow="ESTOQUE / OPERAÇÃO"
        title={`Conferir importação: ${d.lote.fileName}`}
        subtitle={`Lido em ${formatDateTime(d.lote.createdAt)}${d.lote.createdBy === null ? "" : ` por ${d.lote.createdBy}`} · abas ${d.lote.sheetNames.join(", ")}`}
        aside={<Voltar href="/compras/importar" rotulo="Importações" />}
      />

      {existente && (
        <p className="sb-pjf-aviso" role="status">
          Este arquivo já tinha sido importado. Você está no mesmo lote, com o que já foi conferido: nada foi duplicado.
        </p>
      )}

      <section className="sb-imp-resumo" aria-label="Resumo da importação">
        {(
          [
            ["Referências (pedidos)", r.referencias],
            ["SKUs vinculados", r.skus],
            ["Unidades confirmadas", r.unidades],
            ["Pedidos que já existem", r.pedidos_existentes],
            ["Ambíguas", r.ambiguas],
            ["Prováveis", r.provaveis],
            ["Não encontradas", r.nao_encontradas],
            ["Quantidade a confirmar", r.quantidade_a_confirmar],
            ["Sem referência", r.sem_referencia],
            ["Mesmo SKU em várias linhas (somadas)", r.sku_repetido_na_referencia],
            // D-767: ausente até a migration da invoice chegar ao banco — não vira zero.
            ["SKU que já está no pedido", r.ja_no_pedido],
            ["Registradas", r.registradas],
          ] as const
        ).filter(([, n]) => n !== undefined).map(([rotulo, n]) => (
          <div key={rotulo} className="sb-imp-cartao">
            <span>{rotulo}</span>
            <strong>{formatCount(n ?? 0)}</strong>
          </div>
        ))}
      </section>

      <Panel
        title="Pedidos encontrados"
        subtitle="Cada referência vira um pedido. Escolha a situação: “pedido realizado” passa a contar como pendente de chegada; “planejado” não reduz a necessidade."
      >
        {d.grupos.length === 0 ? (
          <EstadoDaTela tipo="vazio" titulo="Nenhuma referência para registrar" />
        ) : (
          <div className="sb-imp-grupos">
            {d.grupos.map((g) => (
              <GrupoRegistro key={g.referenciaKey ?? "sem-referencia"} loteId={loteId} grupo={g} fornecedores={fornecedores.data ?? []} />
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title="Linhas da planilha"
        subtitle={`${formatCount(d.total)} linha(s)${filtro === null ? "" : ` em “${FILTROS[filtro]}”`}. A origem (aba, linha e coluna) e o texto original ficam guardados; corrigir não apaga o que era.`}
        aside={
          <nav className="sb-imp-filtros" aria-label="Filtrar linhas">
            <Link className={filtro === null ? "sb-button sb-button-primary" : "sb-button"} href={href(null)}>
              Todas
            </Link>
            {(Object.keys(FILTROS) as (keyof typeof FILTROS)[]).map((f) => (
              <Link key={f} className={filtro === f ? "sb-button sb-button-primary" : "sb-button"} href={href(f)}>
                {FILTROS[f]}
              </Link>
            ))}
          </nav>
        }
      >
        <div style={{ overflowX: "auto" }}>
          <table className="sb-table sb-imp-linhas">
            <thead>
              <tr>
                <th>Origem</th>
                <th>Na planilha</th>
                <th>Vínculo</th>
                <th>Quantidade</th>
                <th>Referência</th>
                <th>
                  <span className="sb-sr-only">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {d.linhas.map((l) => (
                <LinhaConferencia key={l.id} loteId={loteId} linha={l} />
              ))}
            </tbody>
          </table>
        </div>
        {totalPaginas > 1 && (
          <p className="sb-rep-paginas">
            {pagina > 1 && (
              <Link className="sb-button" href={href(filtro, pagina - 1)}>
                ‹ Anterior
              </Link>
            )}
            <span>
              {pagina} de {totalPaginas}
            </span>
            {pagina < totalPaginas && (
              <Link className="sb-button" href={href(filtro, pagina + 1)}>
                Próxima ›
              </Link>
            )}
          </p>
        )}
      </Panel>
    </>
  );
}
