import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { formatCount } from "../../lib/format";
import { createClient } from "../../lib/supabase/server";

import { CurationTable, type CurationRow } from "./curation-table";
import { KpiStrip } from "../../components/kpi-strip";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { currentMembership } from "../../lib/membership";

export const metadata = { title: "Produtos — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio de /compras.
export const dynamic = "force-dynamic";

/**
 * Curadoria do catálogo (D-133).
 *
 * Existe porque duas colunas de `skus` só podem ser preenchidas por gente, e
 * marcar 2.306 SKUs um a um não é realista:
 *
 * - `stock_is_virtual` (D-127) — o saldo do ERP é sentinela, não contagem, e
 *   não há regra derivável (a hipótese "base menos vendas" foi testada e
 *   reprovada, correlação 0,291).
 * - `supplier_brand` (D-129) — `skus.brand` guarda a CATEGORIA do UpSeller
 *   (66% em 'MANETE') e o importador a sobrescreve a cada planilha.
 *
 * A tela SUGERE pela assinatura sentinela e nunca aplica sozinha: o operador
 * confirma num painel que diz a CONSEQUÊNCIA, não só a contagem.
 *
 * Todo o filtro vive na URL, nunca em estado React — só assim os Filtros
 * Salvos continuam funcionando e o link de ida de `/cobertura` chega com o
 * recorte certo.
 */

const PAGE_SIZE = 100;

const ESTADOS = { pendente: "PENDENTE", virtual: "VIRTUAL", fisico: "FISICO", todos: null } as const;
const SINAIS = { sentinela: "SENTINELA", "sem-sinal": "SEM_SINAL", "sem-retrato": "SEM_RETRATO", divergente: "DIVERGENTE" } as const;

type EstadoChave = keyof typeof ESTADOS;
type SinalChave = keyof typeof SINAIS;

/** Resolve contra lista fechada e cai no default EM SILÊNCIO — URL é entrada de terceiro. */
function lerEstado(bruto: string | undefined): EstadoChave {
  return bruto !== undefined && bruto in ESTADOS ? (bruto as EstadoChave) : "pendente";
}

function lerSinal(bruto: string | undefined): SinalChave | null {
  return bruto !== undefined && bruto in SINAIS ? (bruto as SinalChave) : null;
}

function lerPagina(bruto: string | undefined): number {
  const n = Number(bruto ?? "1");

  return Number.isInteger(n) && n >= 1 ? n : 1;
}


/**
 * O gerador de tipos NÃO marca nulidade de `returns table` — declara tudo
 * como não-nulo. Aqui isso importa de verdade: `supplier_brand` é NULO na
 * linha dos SKUs sem marca, e a linha TOTAL do `grouping sets` também vem com
 * ela nula. Sem esta interface, o código que distingue as duas não compila —
 * e, pior, o lint acusaria a comparação como "sem sobreposição", que é
 * exatamente o contrário do que o dado faz. Mesmo molde de `CoverageRow`.
 */
interface SummaryRow {
  is_total: boolean;
  supplier_brand: string | null;
  total: number;
  unclassified: number;
  virtual_marked: number;
  with_signature: number;
  diverging: number;
  snapshot_captured_at: string | null;
}

interface Busca {
  estado: EstadoChave;
  sinal: SinalChave | null;
  marca: string | null;
  busca: string;
  page: number;
}

/** Preserva as outras dimensões e omite o que é default. */
function buildHref(atual: Busca, override: Partial<Busca>): string {
  const proximo = { ...atual, ...override };
  const p = new URLSearchParams();

  if (proximo.estado !== "pendente") p.set("estado", proximo.estado);
  if (proximo.sinal !== null) p.set("sinal", proximo.sinal);
  if (proximo.marca !== null) p.set("marca", proximo.marca);
  if (proximo.busca !== "") p.set("busca", proximo.busca);
  if (proximo.page > 1) p.set("page", String(proximo.page));

  const qs = p.toString();

  return qs === "" ? "/produtos" : `/produtos?${qs}`;
}

export default async function ProdutosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const params = await searchParams;
  const um = (chave: string): string | undefined => {
    const v = params[chave];

    return Array.isArray(v) ? v[0] : v;
  };

  const atual: Busca = {
    estado: lerEstado(um("estado")),
    sinal: lerSinal(um("sinal")),
    marca: um("marca") ?? null,
    busca: um("busca") ?? "",
    page: lerPagina(um("page")),
  };

  const supabase = await createClient();

  // `.limit(1)` e não `.maybeSingle()` sem filtro: numa organização com dois
  // membros o `maybeSingle` estoura PGRST116 e a tela inteira morre — o
  // defeito que D-119 mediu e corrigiu.
  const membership = await currentMembership(supabase);
  const organizationId = membership.organizationId;

  if (membership.error !== null) {
    // Distinto de "sem organização": aquela mensagem sugere problema de
    // cadastro; isto é falha de leitura transitória (D-067, Nível 3).
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Produtos</h1>
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível confirmar sua organização: {membership.error.message}
        </p>
      </Shell>
    );
  }

  if (organizationId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Produtos</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const semMarca = atual.marca === "__sem__";

  const [fila, resumo] = await Promise.all([
    supabase.rpc("get_sku_curation", {
      p_organization_id: organizationId,
      p_missing_brand: semMarca,
      p_limit: PAGE_SIZE,
      p_offset: (atual.page - 1) * PAGE_SIZE,
      // Filtro opcional por spread condicional: com `exactOptionalPropertyTypes`
      // passar `undefined` não é o mesmo que omitir a chave.
      ...(atual.estado === "todos" ? {} : { p_classified: ESTADOS[atual.estado] }),
      ...(atual.sinal === null ? {} : { p_signal: SINAIS[atual.sinal] }),
      ...(atual.marca === null || semMarca ? {} : { p_brand: atual.marca }),
      ...(atual.busca === "" ? {} : { p_search: atual.busca }),
    }),
    supabase.rpc("get_sku_curation_summary", { p_organization_id: organizationId }),
  ]);

  const error = fila.error ?? resumo.error;

  if (error !== null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Produtos</h1>
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar a curadoria: {error.message}
        </p>
      </Shell>
    );
  }

  const rows = (fila.data ?? []) as CurationRow[];
  const totalFiltrado = rows[0]?.total_count ?? 0;

  const linhas = (resumo.data ?? []) as SummaryRow[];
  const total = linhas.find((l) => l.is_total) ?? null;
  const porMarca = linhas.filter((l) => !l.is_total);
  const marcasConhecidas = porMarca
    .map((l) => l.supplier_brand)
    .filter((m): m is string => m !== null)
    .sort((a, b) => a.localeCompare(b));

  const semMarcaTotal = porMarca.find((l) => l.supplier_brand === null)?.total ?? 0;
  const retrato = total?.snapshot_captured_at ?? null;

  const rotuloEstado =
    atual.estado === "pendente"
      ? "Não classificados"
      : atual.estado === "virtual"
        ? "Virtuais"
        : atual.estado === "fisico"
          ? "Físicos"
          : "Todos os estados";

  const rotuloSinal =
    atual.sinal === null
      ? "Qualquer sinal"
      : atual.sinal === "sentinela"
        ? "Parece sentinela"
        : atual.sinal === "sem-sinal"
          ? "Não parece sentinela"
          : atual.sinal === "sem-retrato"
            ? "Sem retrato"
            : "Divergentes";

  return (
    <Shell>
      <PageTitle
        eyebrow="INTELIGÊNCIA / CURADORIA"
        title="Curadoria de produtos"
        subtitle={
          <>
            As duas coisas que só uma pessoa pode decidir. <strong>Estoque virtual</strong> é o SKU cujo saldo no
            ERP é um sentinela — número alto para o anúncio não pausar, não contagem física (D-127).{" "}
            <strong>Marca do fornecedor</strong> existe porque a coluna <code>Categorias</code> do UpSeller não é
            marca (D-129). A sugestão é medida, e <strong>nunca</strong> aplicada sozinha.
          </>
        }
        aside={
          <>
            {/*
              Os filtros viraram a barra de menus do Figma, como em `/vendas`.
              Todo o recorte continua na URL, nunca em estado React — só assim os
              Filtros Salvos continuam funcionando e o link de ida de
              `/cobertura` chega com o recorte certo.
            */}
            <details className="sb-menu">
              <summary className="sb-button">{rotuloEstado} ▾</summary>
              <div className="sb-menu-panel">
                {(["pendente", "virtual", "fisico", "todos"] as EstadoChave[]).map((chave) => (
                  <a
                    key={chave}
                    className="sb-menu-item"
                    aria-current={atual.estado === chave ? "true" : undefined}
                    href={buildHref(atual, { estado: chave, page: 1 })}
                  >
                    {chave === "pendente"
                      ? "Não classificados"
                      : chave === "virtual"
                        ? "Virtuais"
                        : chave === "fisico"
                          ? "Físicos"
                          : "Todos os estados"}
                  </a>
                ))}
              </div>
            </details>

            <details className="sb-menu">
              <summary className="sb-button">{rotuloSinal} ▾</summary>
              <div className="sb-menu-panel">
                <a
                  className="sb-menu-item"
                  aria-current={atual.sinal === null ? "true" : undefined}
                  href={buildHref(atual, { sinal: null, page: 1 })}
                >
                  Qualquer sinal
                </a>
                {(["sentinela", "sem-sinal", "sem-retrato", "divergente"] as SinalChave[]).map((chave) => (
                  <a
                    key={chave}
                    className="sb-menu-item"
                    aria-current={atual.sinal === chave ? "true" : undefined}
                    href={buildHref(atual, { sinal: chave, page: 1 })}
                  >
                    {chave === "sentinela"
                      ? "Parece sentinela"
                      : chave === "sem-sinal"
                        ? "Não parece sentinela"
                        : chave === "sem-retrato"
                          ? "Sem retrato"
                          : "Divergentes"}
                  </a>
                ))}
              </div>
            </details>

            <details className="sb-menu">
              <summary className="sb-button">{semMarca ? "Sem marca" : "Todas as marcas"} ▾</summary>
              <div className="sb-menu-panel">
                <a
                  className="sb-menu-item"
                  aria-current={semMarca ? undefined : "true"}
                  href={buildHref(atual, { marca: null, page: 1 })}
                >
                  Todas as marcas
                </a>
                <a
                  className="sb-menu-item"
                  aria-current={semMarca ? "true" : undefined}
                  href={buildHref(atual, { marca: "__sem__", page: 1 })}
                >
                  Sem marca
                </a>
              </div>
            </details>

            <form method="get" action="/produtos" style={{ display: "flex", gap: "0.375rem" }}>
              {atual.estado !== "pendente" && <input type="hidden" name="estado" value={atual.estado} />}
              {atual.sinal !== null && <input type="hidden" name="sinal" value={atual.sinal} />}
              {atual.marca !== null && <input type="hidden" name="marca" value={atual.marca} />}
              <input
                type="search"
                name="busca"
                defaultValue={atual.busca}
                placeholder="SKU ou título"
                aria-label="Buscar SKU ou título"
                style={{
                  height: "2rem",
                  padding: "0 0.625rem",
                  borderRadius: "var(--sb-radius-md)",
                  border: "1px solid var(--sb-border)",
                  fontSize: "0.6875rem",
                  minWidth: "12rem",
                }}
              />
              <button type="submit" className="sb-button">
                Buscar
              </button>
            </form>
          </>
        }
      />

      <div className="sb-section-label">
        <span>Retrato do ERP</span>
        <span className="sb-section-note">
          {retrato === null
            ? "nenhuma planilha de estoque aplicada ainda — sem retrato, não há sugestão para dar"
            : `capturado em ${new Date(retrato).toLocaleDateString("pt-BR")} — a sugestão vale para este retrato, não para hoje`}
        </span>
      </div>

      {/*
        Os contadores do retrato viram a faixa do Figma. Eles NÃO levam id de
        métrica: são estados do catálogo, não métricas catalogadas em
        `metric_definitions`, e apontar para uma definição que não existe é pior
        do que não apontar.
      */}
      <KpiStrip
        ancora
        cells={[
          {
            label: "Nunca classificados",
            formula: "SKUs sem decisão de estoque virtual",
            value: formatCount(total?.unclassified ?? 0),
            previous: null,
          },
          {
            label: "Sem marca do fornecedor",
            formula: "SKUs com supplier_brand nulo",
            value: formatCount(semMarcaTotal),
            previous: null,
          },
          {
            label: "Marcados como virtual",
            formula: "SKUs com stock_is_virtual = true",
            value: formatCount(total?.virtual_marked ?? 0),
            previous: null,
          },
          {
            label: "A revisar",
            formula: "o ERP mudou debaixo de uma decisão já tomada",
            value: formatCount(total?.diverging ?? 0),
            previous: null,
          },
        ]}
      />

      <div style={{ marginTop: "var(--sb-space-3)" }}>
        {rows.length === 0 ? (
          <Panel title="Catálogo" subtitle="Nenhum SKU neste recorte.">
            <p style={{ margin: 0, padding: "var(--sb-space-2) var(--sb-space-3) var(--sb-space-3)", color: "var(--sb-text-soft)", fontSize: "0.6875rem" }}>
              Tire um filtro ou busque outro termo.
            </p>
          </Panel>
        ) : (
          <>
            <CurationTable organizationId={organizationId} rows={rows} marcasConhecidas={marcasConhecidas} />

            <p style={{ margin: "var(--sb-space-2) 0 0", fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>
              {formatCount(rows.length)} de {formatCount(totalFiltrado)} neste recorte
              {atual.page > 1 && (
                <>
                  {" · "}
                  <a href={buildHref(atual, { page: atual.page - 1 })}>Anterior</a>
                </>
              )}
              {atual.page * PAGE_SIZE < totalFiltrado && (
                <>
                  {" · "}
                  <a href={buildHref(atual, { page: atual.page + 1 })}>Próxima</a>
                </>
              )}
              {" · "}
              {formatCount(total?.virtual_marked ?? 0)} marcados como virtual têm a cobertura em branco de
              propósito em <a href="/cobertura">Cobertura</a>.
            </p>
          </>
        )}
      </div>
    </Shell>
  );
}
