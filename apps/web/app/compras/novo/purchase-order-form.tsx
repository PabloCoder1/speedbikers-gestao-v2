"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Icone } from "../../../components/icons";
import { ProcessSteps } from "../../../components/process-steps";
import { formatBusinessDate, formatCount, formatCurrency } from "../../../lib/format";
import { createClient } from "../../../lib/supabase/browser";
import { formatarDocumento, idadeRelativa, iniciais } from "../../../lib/suppliers-overview";
import { Canais } from "../../fornecedores/canais";
import { createPurchaseOrder, updatePurchaseOrderDraft } from "../actions";

import { ItemRow, type DraftItem, type UltimaCompra } from "./item-row";
import { detectOriginMix } from "./prefill";
import {
  custoInformado,
  diasEntre,
  hojeSaoPaulo,
  lerListaColada,
  numeroPositivo,
  prazoPorExtenso,
  resumirRascunho,
  somarDias,
} from "./rascunho";

/**
 * O formulário do pedido de compra — criação e edição do rascunho.
 *
 * D-368: era uma coluna de campos soltos e uma tabela de três colunas, sem
 * dizer quanto o pedido somava nem com quem se estava comprando. Agora:
 *
 * - **resumo fixo ao lado** (itens, unidades, valor estimado com a ressalva de
 *   custo ausente, previsão, destino) e o botão sempre à vista;
 * - **o fornecedor escolhido aparece como ficha**: documento, contato
 *   clicável, pedidos em aberto e último pedido — o que se confere antes de
 *   mandar um pedido;
 * - **previsão com atalhos** (+7, +15, +30, +45 dias) e o prazo por extenso;
 * - **itens**: subtotal por linha, último custo pago ao fornecedor, aviso de
 *   SKU repetido, Enter para a próxima linha e "Colar lista" de planilha.
 *
 * O que NÃO mudou, porque outras telas dependem: `?fornecedor=` e `?sku=`
 * (D-151/D-365) chegam por `initial`; `expectedAt` continua data de negócio
 * `AAAA-MM-DD` gravada como meia-noite UTC — a lista, o detalhe e os exports
 * cortam com `slice(0, 10)`; e este mesmo componente serve
 * `/compras/[id]/editar`.
 */

let keyCounter = 0;

function emptyItem(): DraftItem {
  keyCounter += 1;

  return {
    key: `item-${String(keyCounter)}`,
    skuId: null,
    skuSnapshot: "",
    titleSnapshot: null,
    isImported: null,
    quantityOrdered: "",
    unitCost: "",
  };
}

export interface PurchaseOrderFormInitial {
  supplierId: string | null;
  destinationWarehouseName: string | null;
  notes: string | null;
  /** Data de negócio `YYYY-MM-DD` — já vem cortada de `expected_at`, nunca `new Date(...)` aqui (mesmo raciocínio de `formatBusinessDate`). */
  expectedAt: string | null;
  items: DraftItem[];
}

/** Os campos além de id e nome são opcionais: a edição passa só os dois. */
export interface FornecedorOpcao {
  id: string;
  name: string;
  document?: string | null;
  contactName?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  website?: string | null;
  ordersEmAberto?: number;
  ultimoPedidoEm?: string | null;
}

const ATALHOS_PRAZO = [7, 15, 30, 45] as const;

export function PurchaseOrderForm({
  suppliers,
  orderId,
  initial,
  organizationId,
  destinosRecentes = [],
}: {
  suppliers: FornecedorOpcao[];
  /** Presente = editando um rascunho existente; ausente = criando um pedido novo. */
  orderId?: string;
  initial?: PurchaseOrderFormInitial;
  /** Sem ele, a linha não mostra o último custo pago ao fornecedor. */
  organizationId?: string;
  /** Destinos usados nos pedidos recentes, como sugestão do campo. */
  destinosRecentes?: readonly string[];
}): ReactNode {
  const router = useRouter();
  const isEditing = orderId !== undefined;

  const [supplierId, setSupplierId] = useState(initial?.supplierId ?? "");
  const [destinationWarehouseName, setDestinationWarehouseName] = useState(initial?.destinationWarehouseName ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [expectedAt, setExpectedAt] = useState(initial?.expectedAt ?? "");
  const [items, setItems] = useState<DraftItem[]>(
    // Pré-seleção só de fornecedor (D-365) chega sem item: a linha vazia continua lá.
    initial !== undefined && initial.items.length > 0 ? initial.items : [emptyItem()],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [colando, setColando] = useState(false);
  const [textoColado, setTextoColado] = useState("");
  const [avisoColagem, setAvisoColagem] = useState<string | null>(null);
  const [lendoColagem, setLendoColagem] = useState(false);
  const [ultimasCompras, setUltimasCompras] = useState<Map<string, UltimaCompra>>(new Map());
  // `hoje` só no cliente: no servidor a data sairia do fuso da máquina de build.
  const [hoje, setHoje] = useState<string | null>(null);
  const focarLinha = useRef<string | null>(null);
  const tabelaRef = useRef<HTMLTableSectionElement | null>(null);

  useEffect(() => {
    setHoje(hojeSaoPaulo(new Date()));
  }, []);

  const fornecedor = suppliers.find((s) => s.id === supplierId) ?? null;
  const resumo = useMemo(() => resumirRascunho(items), [items]);
  const mix = detectOriginMix(items.filter((i) => i.skuSnapshot.trim() !== ""));

  // O ÚLTIMO CUSTO pago a este fornecedor, por SKU — uma leitura por troca de
  // fornecedor, não por linha. Falha aqui só tira a referência, nunca o pedido.
  useEffect(() => {
    if (supplierId === "" || organizationId === undefined) {
      setUltimasCompras(new Map());

      return;
    }

    const estado = { vigente: true };

    void (async () => {
      const { data, error: erro } = await createClient().rpc("get_supplier_purchased_skus", {
        p_organization_id: organizationId,
        p_supplier_id: supplierId,
        p_limit: 500,
        p_offset: 0,
      });

      if (!estado.vigente) return;

      const mapa = new Map<string, UltimaCompra>();

      if (erro === null) {
        for (const linha of data) {
          // O tipo gerado diz `number`, mas o último item pode ter sido pedido
          // sem custo: nulo aqui é "sem referência", nunca R$ 0,00.
          const custo = linha.ultimo_custo as number | null;

          if (linha.sku_id !== null && custo !== null) {
            mapa.set(linha.sku_id, { custo, pedido: linha.ultimo_pedido_numero, em: linha.ultimo_pedido_em });
          }
        }
      }

      setUltimasCompras(mapa);
    })();

    return () => {
      estado.vigente = false;
    };
  }, [supplierId, organizationId]);

  // Depois de "Enter" ou "Adicionar item", o foco vai para o SKU da linha nova.
  useEffect(() => {
    if (focarLinha.current === null) return;

    const alvo = tabelaRef.current?.querySelector<HTMLInputElement>(`[data-linha="${focarLinha.current}"] input`);

    focarLinha.current = null;
    alvo?.focus();
  }, [items]);

  function updateItem(key: string, next: DraftItem): void {
    setItems((current) => current.map((item) => (item.key === key ? next : item)));
  }

  function removeItem(key: string): void {
    setItems((current) => (current.length <= 1 ? current : current.filter((item) => item.key !== key)));
  }

  function adicionarLinha(): void {
    const nova = emptyItem();

    focarLinha.current = nova.key;
    setItems((current) => [...current, nova]);
  }

  async function adicionarColados(): Promise<void> {
    const linhas = lerListaColada(textoColado);

    if (linhas.length === 0) {
      setAvisoColagem("Nada para adicionar — cole uma linha por item: SKU, quantidade e custo.");

      return;
    }

    setLendoColagem(true);
    setAvisoColagem(null);

    const { data, error: erro } = await createClient()
      .from("skus")
      .select("id, sku, sku_key, title, is_imported, purchase_cost, supplier_brand")
      .in(
        "sku_key",
        linhas.map((l) => l.sku.trim().toUpperCase()),
      );

    setLendoColagem(false);

    if (erro !== null) {
      setAvisoColagem("Não foi possível conferir os SKUs no catálogo — tente de novo.");

      return;
    }

    const porChave = new Map(data.map((s) => [s.sku_key, s]));
    let catalogados = 0;

    const novos: DraftItem[] = linhas.map((l) => {
      const base = emptyItem();
      const sku = porChave.get(l.sku.trim().toUpperCase());
      const quantidade = l.quantidade === null ? "" : String(l.quantidade);

      if (sku === undefined) {
        return { ...base, skuSnapshot: l.sku, quantityOrdered: quantidade, unitCost: l.custo === null ? "" : String(l.custo) };
      }

      catalogados += 1;
      const sugerido = l.custo === null && sku.purchase_cost !== null;

      return {
        ...base,
        skuId: sku.id,
        skuSnapshot: sku.sku,
        titleSnapshot: sku.title,
        isImported: sku.is_imported,
        supplierBrand: sku.supplier_brand,
        quantityOrdered: quantidade,
        unitCost: l.custo !== null ? String(l.custo) : sku.purchase_cost === null ? "" : String(sku.purchase_cost),
        unitCostSuggested: sugerido,
      };
    });

    // A linha vazia do começo dá lugar à lista colada.
    setItems((current) => [
      ...current.filter((i) => i.skuSnapshot.trim() !== "" || i.quantityOrdered.trim() !== "" || i.unitCost.trim() !== ""),
      ...novos,
    ]);

    const livres = novos.length - catalogados;

    setAvisoColagem(
      `${formatCount(novos.length)} item(ns) adicionados: ${formatCount(catalogados)} do catálogo` +
        (livres > 0 ? `, ${formatCount(livres)} como código livre (vínculo pendente).` : "."),
    );
    setTextoColado("");
    setColando(false);
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);

    const validItems = items.filter((item) => item.skuSnapshot.trim() !== "" && item.quantityOrdered.trim() !== "");

    if (validItems.length === 0) {
      setError("Adicione ao menos um item com SKU e quantidade.");
      setBusy(false);

      return;
    }

    // Sem a validação nativa, a conferência de número é daqui — dizendo a linha.
    const invalida = items.findIndex(
      (item) =>
        item.skuSnapshot.trim() !== "" &&
        item.quantityOrdered.trim() !== "" &&
        (numeroPositivo(item.quantityOrdered) === null ||
          (item.unitCost.trim() !== "" && custoInformado(item.unitCost) === null)),
    );

    if (invalida >= 0) {
      setError(`Linha ${String(invalida + 1)}: a quantidade precisa ser maior que zero e o custo não pode ser negativo.`);
      setBusy(false);

      return;
    }

    const input = {
      supplierId: supplierId === "" ? null : supplierId,
      destinationWarehouseName: destinationWarehouseName.trim() === "" ? null : destinationWarehouseName.trim(),
      currency: "BRL",
      notes: notes.trim() === "" ? null : notes.trim(),
      // Data de negócio como meia-noite UTC: os leitores cortam com `slice(0, 10)`.
      expectedAt: expectedAt === "" ? null : new Date(expectedAt).toISOString(),
      items: validItems.map((item) => ({
        skuId: item.skuId,
        skuSnapshot: item.skuSnapshot.trim(),
        titleSnapshot: item.titleSnapshot,
        quantityOrdered: Number(item.quantityOrdered),
        unitCost: item.unitCost.trim() === "" ? null : Number(item.unitCost),
      })),
    };

    if (isEditing) {
      const result = await updatePurchaseOrderDraft(orderId, input);

      if (!result.ok) {
        setError(result.message ?? "Não foi possível salvar as alterações.");
        setBusy(false);

        return;
      }

      router.push(`/compras/${orderId}`);

      return;
    }

    const result = await createPurchaseOrder(input);

    if (!result.ok || result.id === undefined) {
      setError(result.message ?? "Não foi possível criar o pedido.");
      setBusy(false);

      return;
    }

    router.push(`/compras/${result.id}`);
  }

  const prazo = hoje !== null && expectedAt !== "" ? diasEntre(hoje, expectedAt) : null;

  return (
    <form
      className="sb-pco"
      /*
        Sem a validação nativa: linha vazia sobrando (o Enter abre uma nova) e
        custo com três casas travavam o envio com um balão do navegador. O
        envio já descarta linha vazia e exige ao menos um item.
      */
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="sb-pco-principal">
        {/* FORNECEDOR E ENTREGA */}
        <section className="sb-pco-cartao" aria-labelledby="pco-fornecedor">
          <header className="sb-pco-cartao-topo">
            <span className="sb-pco-passo" aria-hidden="true">
              1
            </span>
            <div>
              <h2 id="pco-fornecedor">Fornecedor e entrega</h2>
              <p>De quem se compra, para onde vai e quando chega.</p>
            </div>
          </header>

          <div className="sb-pco-grade">
            <label className="sb-form-campo sb-pco-largo" htmlFor="pco-supplier">
              <span>Fornecedor</span>
              <select
                id="pco-supplier"
                className="sb-input sb-input-full"
                value={supplierId}
                onChange={(event) => {
                  setSupplierId(event.target.value);
                }}
              >
                <option value="">Sem fornecedor definido ainda</option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                    {supplier.ordersEmAberto !== undefined && supplier.ordersEmAberto > 0
                      ? ` · ${String(supplier.ordersEmAberto)} em aberto`
                      : ""}
                  </option>
                ))}
              </select>
              {suppliers.length === 0 && (
                <small>
                  Nenhum fornecedor ativo. <Link href="/fornecedores/novo">Cadastrar fornecedor</Link>
                </small>
              )}
            </label>

            {fornecedor !== null ? (
              <div className="sb-pco-ficha sb-pco-largo">
                <span className="sb-avatar sb-pco-ficha-avatar" aria-hidden="true">
                  {iniciais(fornecedor.name)}
                </span>
                <div className="sb-pco-ficha-corpo">
                  <div className="sb-pco-ficha-nome">
                    <b>{fornecedor.name}</b>
                    {fornecedor.document !== null && fornecedor.document !== undefined && (
                      <span className="sb-mono">{formatarDocumento(fornecedor.document)}</span>
                    )}
                  </div>
                  <div className="sb-pco-ficha-fatos">
                    {fornecedor.contactName !== null && fornecedor.contactName !== undefined && (
                      <span>Contato: {fornecedor.contactName}</span>
                    )}
                    {fornecedor.ordersEmAberto !== undefined && (
                      <span className={fornecedor.ordersEmAberto > 0 ? "sb-pco-ficha-aberto" : undefined}>
                        {fornecedor.ordersEmAberto > 0
                          ? `${formatCount(fornecedor.ordersEmAberto)} pedido(s) em aberto`
                          : "nenhum pedido em aberto"}
                      </span>
                    )}
                    {fornecedor.ultimoPedidoEm !== undefined && (
                      <span>
                        {fornecedor.ultimoPedidoEm === null
                          ? "primeiro pedido com ele"
                          : `último pedido ${idadeRelativa(fornecedor.ultimoPedidoEm, new Date()) ?? ""}`}
                      </span>
                    )}
                  </div>
                  <div className="sb-pco-ficha-acoes">
                    <Canais
                      canais={{
                        whatsapp: fornecedor.whatsapp ?? null,
                        phone: fornecedor.phone ?? null,
                        email: fornecedor.email ?? null,
                        website: fornecedor.website ?? null,
                      }}
                      compacto
                    />
                    <Link href={`/fornecedores/${fornecedor.id}`} target="_blank" className="sb-pco-link-discreto">
                      Ver fornecedor ↗
                    </Link>
                  </div>
                </div>
              </div>
            ) : (
              <p className="sb-pco-nota sb-pco-largo">
                Pode criar o rascunho sem fornecedor e definir depois — ele só é exigido para seguir o ciclo de compra.
              </p>
            )}

            <label className="sb-form-campo" htmlFor="pco-destino">
              <span>Armazém de destino</span>
              <input
                id="pco-destino"
                className="sb-input sb-input-full"
                value={destinationWarehouseName}
                list={destinosRecentes.length > 0 ? "pco-destinos" : undefined}
                placeholder="ex.: Depósito Central"
                onChange={(event) => {
                  setDestinationWarehouseName(event.target.value);
                }}
              />
              {destinosRecentes.length > 0 && (
                <datalist id="pco-destinos">
                  {destinosRecentes.map((destino) => (
                    <option key={destino} value={destino} />
                  ))}
                </datalist>
              )}
            </label>

            <div className="sb-form-campo">
              <label htmlFor="pco-previsao">Previsão de chegada</label>
              <input
                id="pco-previsao"
                className="sb-input sb-input-full"
                type="date"
                value={expectedAt}
                onChange={(event) => {
                  setExpectedAt(event.target.value);
                }}
              />
              <div className="sb-pco-atalhos" role="group" aria-label="Atalhos de prazo">
                {ATALHOS_PRAZO.map((dias) => {
                  const data = hoje === null ? null : somarDias(hoje, dias);

                  return (
                    <button
                      key={dias}
                      type="button"
                      className={data !== null && data === expectedAt ? "sb-button sb-button-sm sb-pco-chip sb-pco-chip-ativo" : "sb-button sb-button-sm sb-pco-chip"}
                      disabled={data === null}
                      onClick={() => {
                        if (data !== null) setExpectedAt(data);
                      }}
                    >
                      +{dias} dias
                    </button>
                  );
                })}
                {expectedAt !== "" && (
                  <button
                    type="button"
                    className="sb-button sb-button-sm sb-pco-chip sb-pco-chip-limpar"
                    onClick={() => {
                      setExpectedAt("");
                    }}
                  >
                    limpar
                  </button>
                )}
              </div>
              {prazo !== null && (
                <small className={prazo < 0 ? "sb-pco-alerta-texto" : undefined}>
                  {prazo < 0 ? "Data no passado — " : "Chega "}
                  {prazoPorExtenso(prazo)} ({formatBusinessDate(expectedAt)})
                </small>
              )}
            </div>
          </div>
        </section>

        {/* ITENS */}
        <section className="sb-pco-cartao" aria-labelledby="pco-itens">
          <header className="sb-pco-cartao-topo">
            <span className="sb-pco-passo" aria-hidden="true">
              2
            </span>
            <div>
              <h2 id="pco-itens">Itens</h2>
              <p>Busque pelo código ou pelo nome. O custo cadastrado entra como sugestão e nunca altera o cadastro.</p>
            </div>
            <button
              type="button"
              className="sb-button sb-pco-colar-botao"
              aria-expanded={colando}
              onClick={() => {
                setColando((v) => !v);
                setAvisoColagem(null);
              }}
            >
              <Icone nome="prancheta" tamanho={14} />
              Colar lista
            </button>
          </header>

          {colando && (
            <div className="sb-pco-colar">
              <label htmlFor="pco-colar" className="sb-form-campo">
                <span>Uma linha por item: SKU, quantidade e custo (o custo é opcional)</span>
                <textarea
                  id="pco-colar"
                  className="sb-input sb-input-full sb-mono"
                  rows={5}
                  value={textoColado}
                  placeholder={"ABC-123\t10\t25,90\nXYZ-9;4\nKIT-01 2 199.00"}
                  onChange={(event) => {
                    setTextoColado(event.target.value);
                  }}
                />
                <small>Copie direto da planilha — tabulação, ponto e vírgula ou espaço. SKU repetido soma a quantidade.</small>
              </label>
              <div className="sb-pco-colar-acoes">
                <button
                  type="button"
                  className="sb-button"
                  onClick={() => {
                    setColando(false);
                  }}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="sb-button sb-button-primary"
                  disabled={lendoColagem || textoColado.trim() === ""}
                  onClick={() => {
                    void adicionarColados();
                  }}
                >
                  {lendoColagem ? "Conferindo no catálogo…" : "Adicionar à lista"}
                </button>
              </div>
            </div>
          )}

          {avisoColagem !== null && (
            <p className="sb-pco-nota" role="status">
              {avisoColagem}
            </p>
          )}

          <div className="sb-pco-tabela-rolagem">
            {/*
              `.sb-table` aqui também (D-275): o cabeçalho rotula as MESMAS
              colunas que `/compras/[id]` mostra depois. As células guardam
              campos, então mantêm espaçamento próprio.
            */}
            <table className="sb-table sb-pco-tabela">
              <thead>
                <tr>
                  <th className="sb-pco-num-linha">
                    <span className="sb-sr-only">Número</span>#
                  </th>
                  <th>SKU</th>
                  <th>Quantidade</th>
                  <th>Custo unitário</th>
                  <th className="sb-num">Subtotal</th>
                  <th>
                    <span className="sb-sr-only">Remover</span>
                  </th>
                </tr>
              </thead>

              <tbody ref={tabelaRef}>
                {items.map((item, indice) => (
                  <ItemRow
                    key={item.key}
                    item={item}
                    numero={indice + 1}
                    podeRemover={items.length > 1}
                    duplicada={resumo.duplicadas.has(item.key)}
                    ultimaCompra={item.skuId === null ? null : (ultimasCompras.get(item.skuId) ?? null)}
                    onChange={(next) => {
                      updateItem(item.key, next);
                    }}
                    onRemove={() => {
                      removeItem(item.key);
                    }}
                    onEnterNaQuantidade={adicionarLinha}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <div className="sb-pco-itens-rodape">
            <button className="sb-button" type="button" onClick={adicionarLinha}>
              + Adicionar item
            </button>
            <span className="sb-pco-dica">Enter na quantidade ou no custo abre a próxima linha.</span>
          </div>

          {resumo.duplicadas.size > 0 && (
            <p role="alert" className="sb-pco-aviso">
              O mesmo SKU aparece em mais de uma linha. Pode ser de propósito (custos diferentes), mas costuma ser
              repetição — junte as quantidades se for o caso.
            </p>
          )}

          {mix.mixed && (
            /*
              "Não misturar nacional e importado" (PRD) como AVISO, nunca
              bloqueio (D-151): `is_imported` é origem FISCAL e D-129/D-139
              mediram que ela contradiz a rota de compra em parte do catálogo.
            */
            <p role="alert" className="sb-pco-aviso">
              Este pedido mistura <strong>{mix.imported} importado(s)</strong> e{" "}
              <strong>{mix.national} nacional(is)</strong>
              {mix.unknown > 0 && <> (mais {mix.unknown} sem origem conhecida)</>} — a regra da operação é não misturar
              importação e compra nacional num mesmo pedido. A origem aqui é a FISCAL do cadastro, que erra parte do
              catálogo (D-129); confira pela rota de compra real antes de criar.
            </p>
          )}
        </section>

        {/* OBSERVAÇÕES */}
        <section className="sb-pco-cartao" aria-labelledby="pco-notas">
          <header className="sb-pco-cartao-topo">
            <span className="sb-pco-passo" aria-hidden="true">
              3
            </span>
            <div>
              <h2 id="pco-notas">Observações</h2>
              <p>Condição combinada com o fornecedor. Aparece no pedido e na exportação.</p>
            </div>
          </header>
          <label className="sb-form-campo" htmlFor="pco-observacoes">
            <span className="sb-sr-only">Observações</span>
            <textarea
              id="pco-observacoes"
              className="sb-input sb-input-full"
              value={notes}
              onChange={(event) => {
                setNotes(event.target.value);
              }}
              rows={3}
              placeholder="Prazo de pagamento, frete, pedido mínimo, número da cotação…"
            />
          </label>
        </section>
      </div>

      {/* O RESUMO — sempre à vista, com o botão. */}
      <aside className="sb-pco-resumo" aria-label="Resumo do pedido">
        <div className="sb-pco-resumo-cartao">
          <span className="sb-pco-resumo-rotulo">{isEditing ? "Rascunho em edição" : "Novo rascunho"}</span>

          <div className="sb-pco-resumo-valor">
            <span>Valor estimado</span>
            <strong>{resumo.valor === null ? "sem custo" : formatCurrency(resumo.valor)}</strong>
            {resumo.semCusto > 0 && resumo.valor !== null && (
              <small className="sb-pco-alerta-texto">soma parcial — {formatCount(resumo.semCusto)} item(ns) sem custo</small>
            )}
            {resumo.valor === null && <small className="sb-pco-alerta-texto">nenhum item com custo informado</small>}
          </div>

          <dl className="sb-pco-resumo-fatos">
            <div>
              <dt>Itens</dt>
              <dd>{formatCount(resumo.itens)}</dd>
            </div>
            <div>
              <dt>Unidades</dt>
              <dd>{formatCount(resumo.unidades)}</dd>
            </div>
            <div>
              <dt>Fornecedor</dt>
              <dd>{fornecedor?.name ?? <span className="sb-pco-mudo">a definir</span>}</dd>
            </div>
            <div>
              <dt>Previsão</dt>
              <dd>
                {expectedAt === "" ? (
                  <span className="sb-pco-mudo">sem data</span>
                ) : (
                  <>
                    {formatBusinessDate(expectedAt)}
                    {prazo !== null && <small> · {prazoPorExtenso(prazo)}</small>}
                  </>
                )}
              </dd>
            </div>
            <div>
              <dt>Destino</dt>
              <dd>
                {destinationWarehouseName.trim() === "" ? <span className="sb-pco-mudo">não informado</span> : destinationWarehouseName}
              </dd>
            </div>
          </dl>

          {resumo.incompletas > 0 && (
            <p className="sb-pco-aviso sb-pco-aviso-compacto">
              {formatCount(resumo.incompletas)} linha(s) pela metade (sem SKU ou sem quantidade) ficam de fora.
            </p>
          )}

          {error !== null && (
            <p role="alert" className="sb-note sb-note-perigo" style={{ margin: 0 }}>
              {error}
            </p>
          )}

          <button className="sb-button sb-button-primary sb-pco-enviar" type="submit" disabled={busy}>
            {busy ? "Salvando…" : isEditing ? "Salvar alterações" : "Criar pedido (rascunho)"}
          </button>
          <Link className="sb-button sb-pco-enviar" href={isEditing ? `/compras/${orderId}` : "/compras"}>
            Cancelar
          </Link>
        </div>

        {!isEditing && (
          <div className="sb-pco-resumo-cartao sb-pco-ciclo">
            <span className="sb-pco-resumo-rotulo">Depois de criar</span>
            <ProcessSteps
              rotulo="Ciclo do pedido de compra"
              etapas={[
                { label: "Rascunho", estado: "atual", nota: "editável" },
                { label: "Aprovado", estado: "pendente", nota: "ADMIN ou GESTOR" },
                { label: "Pedido enviado", estado: "pendente" },
                { label: "Recebido", estado: "pendente" },
              ]}
            />
          </div>
        )}
      </aside>
    </form>
  );
}

