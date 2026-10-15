import Link from "next/link";
import type { ReactNode } from "react";

import { PageTitle } from "../../../components/page-title";
import { EstadoDaTela, TENTAR_DE_NOVO } from "../../../components/estado-da-tela";
import { Shell } from "../../../components/shell";
import { Voltar } from "../../../components/voltar";
import { mesmaUrl } from "../../../lib/mesma-url";
import { currentMembership } from "../../../lib/request-membership";
import { podeOperarCompras } from "../../../lib/purchase-order-permission";
import { AcessoRestrito } from "../../../components/acesso-restrito";
import { createClient } from "../../../lib/supabase/server";
import { registeredCost } from "../../../lib/purchase-order-cost";
import { lerVisaoFornecedores } from "../../../lib/suppliers-overview";
import { parseReplenishmentPrefill } from "./prefill";
import { PurchaseOrderForm, type FornecedorOpcao } from "./purchase-order-form";
import type { DraftItem } from "./item-row";

export const metadata = { title: "Novo pedido de compra — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/**
 * Novo pedido de compra — refeito em D-368.
 *
 * Três leituras numa ida (D-185), nenhuma nova no banco:
 *
 * - **fornecedores ativos com a ficha** — `get_suppliers_overview` (D-366),
 *   recorte `ativos`: além do nome, documento, contato e pedidos em aberto,
 *   que o formulário mostra ao escolher. Era `suppliers(id, name)`;
 * - **destinos recentes** — os 50 pedidos mais novos, só a coluna do destino,
 *   para sugerir o armazém sem digitar de novo. Teto fixo: é sugestão, não
 *   relatório;
 * - **o prefill da reposição** (`?sku=`, D-151), só quando existe.
 */
export default async function NovoPedidoDeCompraPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const supabase = await createClient();
  const membership = await currentMembership();
  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <Shell>
        <PageTitle eyebrow="ESTOQUE / OPERAÇÃO" title="Novo pedido de compra" compacto />
        <EstadoDaTela tipo="permissao" titulo="Sua conta não está associada a nenhuma organização." />
      </Shell>
    );
  }

  // O formulário inteiro para quem `create_purchase_order` vai recusar no fim
  // seria trabalho jogado fora — mesmo gate de /fornecedores/novo.
  if (!podeOperarCompras(membership.role)) {
    return <AcessoRestrito titulo="Novo pedido de compra" papel="ADMIN ou GESTOR" />;
  }

  // A ponte cobertura→pedido (D-151): `/reposicao` manda `sku=<uuid>:<qtd>`
  // com a quantidade SUGERIDA; o pedido nasce pré-carregado — SKU, quantidade e
  // custo CADASTRADO como sugestão editável (D-149). A RLS limita o `.in()` à
  // organização: id alheio simplesmente não volta.
  const prefill = parseReplenishmentPrefill(query.sku);

  const [fornecedoresResult, destinosResult, skusResult, marcasResult] = await Promise.all([
    supabase.rpc("get_suppliers_overview", {
      p_organization_id: organizationId,
      p_state: "ativos",
      p_limit: 500,
      p_offset: 0,
    }),
    supabase
      .from("purchase_orders")
      .select("destination_warehouse_name")
      .not("destination_warehouse_name", "is", null)
      .order("created_at", { ascending: false })
      .limit(50),
    prefill.length > 0
      ? supabase
          .from("skus")
          .select("id, sku, title, is_imported, purchase_cost, supplier_brand")
          .in(
            "id",
            prefill.map((p) => p.skuId),
          )
      : Promise.resolve({ data: [] }),
    // As marcas do catálogo (D-194, agregadas no banco), para "Trazer da reposição" (D-371).
    supabase.rpc("get_supplier_brands", { p_organization_id: organizationId }),
  ]);

  const marcas = (marcasResult.data ?? []).map((m) => m.supplier_brand).filter((m) => m.trim() !== "");

  /*
    T-R6: duas leituras que, ao falhar, pareceriam "nada". Os SKUs vindos da
    Reposição sumiriam do rascunho calados (quem clicou "Criar pedido" acharia
    que a sugestão estava vazia), e a lista de marcas do "Trazer da reposição"
    ficaria vazia como se o catálogo não tivesse marca.
  */
  const erroDaReposicao = "error" in skusResult && skusResult.error !== null ? skusResult.error.message : null;
  const erroDasMarcas = marcasResult.error?.message ?? null;

  const visao = fornecedoresResult.error === null ? lerVisaoFornecedores(fornecedoresResult.data) : null;
  const erroFornecedores =
    fornecedoresResult.error?.message ?? (visao === null ? "a leitura dos fornecedores voltou fora do contrato" : null);

  const suppliers: FornecedorOpcao[] = (visao?.linhas ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    document: s.document,
    contactName: s.contact_name,
    phone: s.phone,
    whatsapp: s.whatsapp,
    email: s.email,
    website: s.website,
    logoPath: s.logo_path,
    ordersEmAberto: s.orders_em_aberto,
    ultimoPedidoEm: s.ultimo_pedido_em,
  }));

  // Distintos, na ordem do mais recente, sem diferenciar caixa.
  const destinosRecentes: string[] = [];
  const vistos = new Set<string>();

  for (const linha of destinosResult.data ?? []) {
    const destino = linha.destination_warehouse_name?.trim() ?? "";

    if (destino !== "" && !vistos.has(destino.toLowerCase())) {
      vistos.add(destino.toLowerCase());
      destinosRecentes.push(destino);
    }
  }

  const byId = new Map((skusResult.data ?? []).map((s) => [s.id, s]));

  // `?fornecedor=<uuid>` (D-365): o botão "Novo pedido" do fornecedor chega com
  // ele pré-selecionado. Só vale se o id está na lista de ATIVOS que a RLS
  // devolveu — id alheio, inativo ou malformado é ignorado, nunca erro.
  const fornecedorPedido = typeof query.fornecedor === "string" ? query.fornecedor : null;
  const fornecedorInicial = suppliers.find((s) => s.id === fornecedorPedido) ?? null;

  const prefillItems: DraftItem[] = prefill.flatMap((p) => {
    const sku = byId.get(p.skuId);

    if (sku === undefined) return [];

    return [
      {
        key: `sugestao-${p.skuId}`,
        skuId: sku.id,
        skuSnapshot: sku.sku,
        titleSnapshot: sku.title,
        isImported: sku.is_imported,
        supplierBrand: sku.supplier_brand,
        quantityOrdered: String(p.quantity),
        unitCost: registeredCost(sku.purchase_cost) === null ? "" : String(sku.purchase_cost),
        unitCostSuggested: registeredCost(sku.purchase_cost) !== null,
      },
    ];
  });

  return (
    <Shell>
      <PageTitle
        eyebrow="ESTOQUE / OPERAÇÃO"
        title="Novo pedido de compra"
        subtitle={
          <>
            O pedido nasce como <b>rascunho</b> e só vira compra depois da aprovação.
          </>
        }
        aside={<Voltar href="/compras" rotulo="Pedidos de compra" />}
        compacto
      />

      {/* D-468: a forma única do erro de leitura (D-502), no lugar do aviso provisório da T-R6. */}
      {erroFornecedores !== null && (
        <EstadoDaTela
          tipo="erro"
          titulo="Não foi possível carregar os fornecedores"
          descricao="A lista abaixo pode estar vazia — o rascunho ainda pode ser criado sem fornecedor."
          detalhe={erroFornecedores}
          acao={{ href: mesmaUrl("/compras/novo", query), rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
        />
      )}

      {erroDaReposicao !== null && (
        <EstadoDaTela
          tipo="erro"
          titulo={`Os ${String(prefill.length)} item(ns) vindos da Reposição não puderam ser carregados`}
          descricao={
            <>
              O rascunho abre sem eles. Tente de novo, ou volte à <Link href="/reposicao">Reposição</Link> e marque de
              novo.
            </>
          }
          detalhe={erroDaReposicao}
          acao={{ href: mesmaUrl("/compras/novo", query), rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
        />
      )}

      {erroDasMarcas !== null && (
        <EstadoDaTela
          tipo="erro"
          titulo="Não foi possível carregar as marcas do catálogo"
          descricao="O “Trazer da reposição” fica sem a lista de marcas."
          detalhe={erroDasMarcas}
          acao={{ href: mesmaUrl("/compras/novo", query), rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
        />
      )}

      {prefillItems.length > 0 && (
        <div className="sb-pco-origem" role="status">
          <b>
            {prefillItems.length} item(ns) vindos da <Link href="/reposicao">Reposição</Link>
          </b>
          <span>Com a quantidade sugerida e o custo cadastrado — revise à vontade antes de criar.</span>
        </div>
      )}

      <PurchaseOrderForm
        suppliers={suppliers}
        organizationId={organizationId}
        destinosRecentes={destinosRecentes}
        marcas={marcas}
        {...(prefillItems.length > 0 || fornecedorInicial !== null
          ? {
              initial: {
                supplierId: fornecedorInicial?.id ?? null,
                destinationWarehouseName: null,
                notes: null,
                expectedAt: null,
                items: prefillItems,
              },
            }
          : {})}
      />
    </Shell>
  );
}
