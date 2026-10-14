"use client";

import { useEffect, useState, type ReactNode } from "react";

import { useDialogo } from "../../../components/use-dialogo";
import { depoisDaRemocao, MOTIVO_MAX } from "../../../lib/shopee-link";
import type { OpcaoSku } from "../../../lib/vinculo-sugestao";
import { BuscaSku } from "../../vinculacoes/busca-sku";

import { removerVinculoShopee, vincularAnuncioShopee } from "./actions";

/**
 * Os dois popups do vínculo manual da Shopee (D-429).
 *
 * A FORMA é a do popup de `/vinculacoes` (D-374) — `.sb-vnc-modal` com topo,
 * corpo e rodapé, e a mesma busca de SKU (`BuscaSku`) —, sem a parte que só o
 * Mercado Livre tem (sugestão pelos pedidos, alvos por variação vista nos
 * pedidos, aviso de Full). Na Shopee a unidade já vem pronta da linha: a
 * variação, ou o item sem variação. Um popup é UM vínculo.
 *
 * A remoção tem popup próprio, curto, com o motivo OBRIGATÓRIO digitado
 * (`remove_shopee_sku_link` recusa sem ele), e diz o que acontece com a linha
 * depois: o SKU do anúncio volta a valer.
 */

/** A unidade de anúncio da linha, no que os popups precisam. */
export interface UnidadeShopee {
  readonly lojaId: string;
  readonly lojaNome: string;
  readonly itemId: number;
  /** Nulo = o item sem variação. */
  readonly modelId: number | null;
  readonly itemName: string | null;
  readonly modelName: string | null;
  /** O SKU que o vendedor digitou no anúncio, cru (aparado). */
  readonly skuAnuncio: string | null;
  /** O SKU vinculado hoje — manual ou pelo SKU do anúncio; nulo sem vínculo. */
  readonly skuAtual: { readonly id: string; readonly sku: string } | null;
  /** O SKU do catálogo que o SKU do anúncio indica (nulo se não indica nenhum). */
  readonly skuPeloAnuncio: string | null;
}

/**
 * - `vincular`: sem vínculo (sem SKU no anúncio, ou SKU fora do catálogo);
 * - `outro-sku`: vinculado pelo SKU do anúncio, e o manual vai vencê-lo;
 * - `trocar`: o vínculo manual existe e muda de SKU.
 */
export type ModoVincularShopee = "vincular" | "outro-sku" | "trocar";

function nomeDaUnidade(unidade: UnidadeShopee): string {
  return unidade.itemName ?? `Item ${String(unidade.itemId)}`;
}

/** "A variação Azul / G" ou "O anúncio" — o sujeito das frases do popup, com o gênero dele. */
function sujeito(unidade: UnidadeShopee): { texto: string; vinculado: string } {
  if (unidade.modelId === null) return { texto: "O anúncio", vinculado: "vinculado" };

  return {
    texto: `A variação ${unidade.modelName ?? String(unidade.modelId)}`,
    vinculado: "vinculada",
  };
}

/** O topo dos dois popups: sobrancelha, nome, e a unidade por extenso. */
function Topo({
  id,
  sobrancelha,
  titulo,
  unidade,
  bloqueado,
  onFechar,
}: {
  id: string;
  sobrancelha: string;
  titulo: string;
  unidade: UnidadeShopee;
  bloqueado: boolean;
  onFechar: () => void;
}): ReactNode {
  return (
    <header className="sb-vnc-topo">
      <div className="sb-vnc-topo-texto">
        <span className="sb-modal-eyebrow">{sobrancelha}</span>
        <h2 id={id}>{titulo}</h2>
        <p className="sb-vnc-meta">
          {unidade.modelName !== null && <span>{unidade.modelName}</span>}
          <span className="sb-mono">item {unidade.itemId}</span>
          {unidade.modelId !== null && <span className="sb-mono">variação {unidade.modelId}</span>}
          <span>{unidade.lojaNome}</span>
        </p>
      </div>
      <button type="button" className="sb-close" aria-label="Fechar" disabled={bloqueado} onClick={onFechar}>
        ×
      </button>
    </header>
  );
}

export function VincularShopeeDialog({
  unidade,
  modo,
  onFechar,
}: {
  unidade: UnidadeShopee;
  modo: ModoVincularShopee;
  onFechar: () => void;
}): ReactNode {
  const [sku, setSku] = useState<OpcaoSku | null>(null);
  const [motivo, setMotivo] = useState("");
  const [gravando, setGravando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  /*
    Esc fecha (menos enquanto grava) e a página por trás não rola — como o
    popup de /vinculacoes. Não usa `useDialogo`: ele poria o foco no primeiro
    botão (o "×"), e aqui o foco é da busca, que abre com `autoFocus`.
  */
  useEffect(() => {
    const anterior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;

    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = overflow;
      anterior?.focus();
    };
  }, []);

  useEffect(() => {
    const tecla = (evento: KeyboardEvent): void => {
      if (evento.key === "Escape" && !gravando) onFechar();
    };

    window.addEventListener("keydown", tecla);

    return () => {
      window.removeEventListener("keydown", tecla);
    };
  }, [onFechar, gravando]);

  // Escolher o SKU que a linha já tem não muda nada: o botão não promete.
  const mesmoSku = sku !== null && unidade.skuAtual !== null && sku.skuId === unidade.skuAtual.id;

  async function gravar(): Promise<void> {
    if (sku === null || mesmoSku) return;

    setGravando(true);
    setErro(null);

    const resultado = await vincularAnuncioShopee({
      lojaId: unidade.lojaId,
      itemId: unidade.itemId,
      modelId: unidade.modelId,
      skuId: sku.skuId,
      motivo,
    });

    setGravando(false);

    if (!resultado.ok) {
      setErro(resultado.message ?? "Não foi possível vincular.");

      return;
    }

    // A ação já refez a tela (`revalidatePath`): a linha mostra o vínculo novo.
    onFechar();
  }

  const sobrancelha = modo === "trocar" ? "TROCAR O SKU DO VÍNCULO MANUAL" : "VINCULAR ANÚNCIO SHOPEE";
  const rotuloDoBotao = modo === "trocar" ? "Trocar SKU" : "Vincular";

  return (
    <div
      className="sb-backdrop sb-vnc-fundo"
      onMouseDown={(evento) => {
        if (evento.target === evento.currentTarget && !gravando) onFechar();
      }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="vnc-shopee-titulo" className="sb-modal sb-vnc-modal">
        <Topo
          id="vnc-shopee-titulo"
          sobrancelha={sobrancelha}
          titulo={nomeDaUnidade(unidade)}
          unidade={unidade}
          bloqueado={gravando}
          onFechar={onFechar}
        />

        <div className="sb-vnc-corpo">
          {/* HOJE: o que a linha diz antes do clique, na mesma fonte da tabela. */}
          {modo === "trocar" && unidade.skuAtual !== null && (
            <p className="sb-vnc-nota">
              Hoje: vínculo manual ao SKU <b className="sb-mono">{unidade.skuAtual.sku}</b>.
              {unidade.skuPeloAnuncio !== null && unidade.skuPeloAnuncio !== unidade.skuAtual.sku && (
                <>
                  {" "}
                  O anúncio indica <b className="sb-mono">{unidade.skuPeloAnuncio}</b>.
                </>
              )}
            </p>
          )}

          {modo === "outro-sku" && unidade.skuAtual !== null && (
            <p className="sb-vnc-aviso" role="note">
              <b>O vínculo manual vence o SKU do anúncio.</b> Hoje a linha está vinculada ao SKU{" "}
              <span className="sb-mono">{unidade.skuAtual.sku}</span> pelo SKU digitado no anúncio. Com o vínculo
              manual, mudar o SKU no anúncio da Shopee deixa de mudar o vínculo — para voltar a valer o do anúncio,
              remova o vínculo manual.
            </p>
          )}

          {modo === "vincular" && (
            <p className="sb-vnc-nota">
              {unidade.skuAnuncio === null ? (
                <>O anúncio não tem SKU do vendedor: o vínculo só pode ser feito à mão.</>
              ) : (
                <>
                  O SKU do anúncio, <b className="sb-mono">{unidade.skuAnuncio}</b>, não existe no catálogo. O vínculo
                  manual vale até ser removido, mesmo que o SKU do anúncio mude depois.
                </>
              )}
            </p>
          )}

          <BuscaSku
            autoFocus
            onEscolher={(opcao) => {
              setSku(opcao);
              setErro(null);
            }}
          />

          {sku !== null && (
            <div className="sb-vnc-escolhido" role="status">
              <span className="sb-vnc-seta" aria-hidden="true">
                →
              </span>
              <span>
                {sujeito(unidade).texto} vai para o SKU <b className="sb-mono">{sku.sku}</b>
                {sku.title !== null && <small>{sku.title}</small>}
                {mesmoSku && <small>Esse já é o SKU desta linha — escolha outro.</small>}
              </span>
            </div>
          )}

          <label className="sb-form-campo" htmlFor="vnc-shopee-motivo">
            <span className="sb-vnc-rotulo">
              Motivo <small>— opcional, fica no histórico do vínculo</small>
            </span>
            <input
              id="vnc-shopee-motivo"
              className="sb-input sb-input-full"
              value={motivo}
              maxLength={MOTIVO_MAX}
              autoComplete="off"
              onChange={(evento) => {
                setMotivo(evento.target.value);
              }}
            />
          </label>

          <p className="sb-vnc-nota">
            O vínculo é uma relação dentro do sistema: nada muda no anúncio da Shopee.
          </p>

          {erro !== null && (
            <p role="alert" className="sb-vnc-erro">
              {erro}
            </p>
          )}
        </div>

        <footer className="sb-vnc-rodape">
          <span className="sb-vnc-espaco" />
          <button type="button" className="sb-button" disabled={gravando} onClick={onFechar}>
            Cancelar
          </button>
          <button
            type="button"
            className="sb-button sb-button-primary"
            disabled={gravando || sku === null || mesmoSku}
            onClick={() => void gravar()}
          >
            {gravando ? "Gravando…" : rotuloDoBotao}
          </button>
        </footer>
      </div>
    </div>
  );
}

export function RemoverVinculoShopeeDialog({
  unidade,
  linkId,
  onFechar,
}: {
  unidade: UnidadeShopee;
  linkId: string;
  onFechar: () => void;
}): ReactNode {
  const [motivo, setMotivo] = useState("");
  const [removendo, setRemovendo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  // O foco vai para o motivo — sem ele não há remoção —, e Enter num campo
  // de várias linhas não confirma o que não tem volta.
  const dialogo = useDialogo<HTMLDivElement>(true, onFechar, !removendo);

  async function remover(): Promise<void> {
    setRemovendo(true);
    setErro(null);

    const resultado = await removerVinculoShopee(linkId, motivo);

    setRemovendo(false);

    if (!resultado.ok) {
      setErro(resultado.message ?? "Não foi possível remover o vínculo.");

      return;
    }

    onFechar();
  }

  return (
    <div
      className="sb-backdrop sb-vnc-fundo"
      onMouseDown={(evento) => {
        if (evento.target === evento.currentTarget && !removendo) onFechar();
      }}
    >
      <div
        ref={dialogo}
        role="dialog"
        aria-modal="true"
        aria-labelledby="vnc-shopee-remover-titulo"
        className="sb-modal sb-vnc-modal"
      >
        <Topo
          id="vnc-shopee-remover-titulo"
          sobrancelha="REMOVER VÍNCULO MANUAL"
          titulo={nomeDaUnidade(unidade)}
          unidade={unidade}
          bloqueado={removendo}
          onFechar={onFechar}
        />

        <div className="sb-vnc-corpo">
          <p className="sb-vnc-nota">
            {sujeito(unidade).texto} deixa de estar {sujeito(unidade).vinculado} à mão ao SKU{" "}
            <b className="sb-mono">{unidade.skuAtual?.sku ?? "—"}</b>.{" "}
            {depoisDaRemocao({ skuAnuncio: unidade.skuAnuncio, skuPeloAnuncio: unidade.skuPeloAnuncio })}
          </p>

          <p className="sb-vnc-nota">
            Nada muda na Shopee: o anúncio continua no ar como está. A remoção fica registrada com o seu usuário, a
            data e o motivo.
          </p>

          <label className="sb-form-campo" htmlFor="vnc-shopee-remover-motivo">
            <span className="sb-vnc-rotulo">Motivo da remoção</span>
            <textarea
              id="vnc-shopee-remover-motivo"
              className="sb-input sb-input-full"
              rows={3}
              value={motivo}
              maxLength={MOTIVO_MAX}
              required
              data-foco-inicial
              onChange={(evento) => {
                setMotivo(evento.target.value);
                setErro(null);
              }}
            />
          </label>

          {erro !== null && (
            <p role="alert" className="sb-vnc-erro">
              {erro}
            </p>
          )}
        </div>

        <footer className="sb-vnc-rodape">
          <span className="sb-vnc-espaco" />
          <button type="button" className="sb-button" disabled={removendo} onClick={onFechar}>
            Cancelar
          </button>
          <button
            type="button"
            className="sb-button sb-button-danger"
            disabled={removendo || motivo.trim() === ""}
            onClick={() => void remover()}
          >
            {removendo ? "Removendo…" : "Remover vínculo manual"}
          </button>
        </footer>
      </div>
    </div>
  );
}
