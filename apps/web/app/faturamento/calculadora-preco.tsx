"use client";

import {
  COMISSAO_ML,
  FAIXAS_SHOPEE,
  FRETE_GRATIS_ML_MINIMO,
  calcularPreco,
  faixaShopee,
  type Plataforma,
  type TipoAnuncioMl,
} from "@sb/domain";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { formatCurrency, formatPercent } from "../../lib/format";
import { MARGEM_MINIMA, tomDaMargem } from "../../lib/faturamento";
import { lerNumero } from "../../lib/numero-ptbr";
import { createClient } from "../../lib/supabase/browser";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

/** As logísticas que a cotação aceita, com o nome que o vendedor usa. */
const LOGISTICAS = [
  { valor: "cross_docking", rotulo: "Coleta" },
  { valor: "xd_drop_off", rotulo: "Agência / Mercado Envios Places" },
  { valor: "drop_off", rotulo: "Correios" },
  { valor: "fulfillment", rotulo: "Full" },
  { valor: "self_service", rotulo: "Flex" },
] as const;

type Logistica = (typeof LOGISTICAS)[number]["valor"];

interface Cotacao {
  readonly custoVendedor: number;
  readonly pesoFaturavelG: number | null;
  readonly custoSemDesconto: number | null;
  readonly descontoPercentual: number | null;
}

type EstadoCotacao =
  | { kind: "ociosa" }
  | { kind: "cotando" }
  | { kind: "ok"; cotacao: Cotacao; chave: string }
  | { kind: "erro"; mensagem: string };

const PREFERENCIAS = "sb-calculadora-preco";

/**
 * CALCULADORA DE PREÇO (D-359) — "se eu vender por X, quanto sobra?".
 *
 * A conta mora em `@sb/domain` (`calcularPreco`), pura e testada; aqui fica a
 * entrada e a leitura. O frete do Mercado Livre é a COTAÇÃO OFICIAL (via `api`,
 * com o token da conta), refeita sozinha quando medidas, preço, tipo ou
 * logística mudam. Sem cotação, a margem fica em branco com o motivo — frete
 * zero fingido daria uma margem bonita e falsa.
 *
 * Conta, tipo e logística ficam lembrados neste navegador: é o que se repete de
 * um produto para outro.
 */
export function CalculadoraPreco({
  contas,
  margemMinima = MARGEM_MINIMA,
}: {
  contas: readonly { id: string; label: string }[];
  /** A margem mínima da organização (D-410), para o tom do resultado. */
  margemMinima?: number;
}): ReactNode {
  const [plataforma, setPlataforma] = useState<Plataforma>("mercado_livre");
  const [tipo, setTipo] = useState<TipoAnuncioMl>("classico");
  const [contaId, setContaId] = useState(contas[0]?.id ?? "");
  const [logistica, setLogistica] = useState<Logistica>("cross_docking");
  const [preco, setPreco] = useState("");
  const [custo, setCusto] = useState("");
  const [altura, setAltura] = useState("");
  const [largura, setLargura] = useState("");
  const [comprimento, setComprimento] = useState("");
  const [peso, setPeso] = useState("");
  const [cotacao, setCotacao] = useState<EstadoCotacao>({ kind: "ociosa" });

  useEffect(() => {
    try {
      const salvo = JSON.parse(window.localStorage.getItem(PREFERENCIAS) ?? "{}") as Record<string, unknown>;

      if (salvo.plataforma === "shopee" || salvo.plataforma === "mercado_livre") setPlataforma(salvo.plataforma);
      if (salvo.tipo === "classico" || salvo.tipo === "premium") setTipo(salvo.tipo);
      if (typeof salvo.contaId === "string" && contas.some((c) => c.id === salvo.contaId)) setContaId(salvo.contaId);
      if (LOGISTICAS.some((l) => l.valor === salvo.logistica)) setLogistica(salvo.logistica as Logistica);
    } catch {
      // Preferência é conveniência: sem ela, valem os padrões.
    }
  }, [contas]);

  useEffect(() => {
    try {
      window.localStorage.setItem(PREFERENCIAS, JSON.stringify({ plataforma, tipo, contaId, logistica }));
    } catch {
      // Navegador sem armazenamento: segue sem lembrar.
    }
  }, [plataforma, tipo, contaId, logistica]);

  const valores = {
    preco: lerNumero(preco),
    custo: lerNumero(custo),
    altura: lerNumero(altura),
    largura: lerNumero(largura),
    comprimento: lerNumero(comprimento),
    peso: lerNumero(peso),
  };

  const precisaFrete = plataforma === "mercado_livre" && valores.preco !== null && valores.preco >= FRETE_GRATIS_ML_MINIMO;
  const medidasOk =
    [valores.altura, valores.largura, valores.comprimento, valores.peso].every((v) => v !== null && v > 0) && contaId !== "";

  // A chave da cotação: qualquer mudança nela invalida a cotação anterior.
  const chave = precisaFrete && medidasOk
    ? JSON.stringify([contaId, tipo, logistica, valores.preco, valores.altura, valores.largura, valores.comprimento, valores.peso])
    : null;

  useEffect(() => {
    if (chave === null) {
      setCotacao({ kind: "ociosa" });

      return;
    }

    let cancelada = false;
    const pedido = JSON.parse(chave) as [string, TipoAnuncioMl, Logistica, number, number, number, number, number];

    // Espera a pessoa parar de digitar antes de perguntar ao Mercado Livre.
    const espera = window.setTimeout(() => {
      setCotacao({ kind: "cotando" });

      void (async () => {
        const supabase = createClient();
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;

        if (token === undefined) {
          if (!cancelada) setCotacao({ kind: "erro", mensagem: "Sessão expirada — atualize a página." });

          return;
        }

        try {
          const resposta = await fetch(`${API_URL}/v1/pricing/ml-shipping-quote`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify({
              mlAccountId: pedido[0],
              tipoAnuncio: pedido[1],
              logistica: pedido[2],
              preco: pedido[3],
              alturaCm: pedido[4],
              larguraCm: pedido[5],
              comprimentoCm: pedido[6],
              pesoG: pedido[7],
            }),
          });
          const corpo = (await resposta.json().catch(() => null)) as
            | { cotacao?: Cotacao; error?: { message?: string } }
            | null;

          if (cancelada) return;

          if (!resposta.ok || corpo?.cotacao === undefined) {
            setCotacao({
              kind: "erro",
              mensagem: corpo?.error?.message ?? `Não foi possível cotar o frete (HTTP ${String(resposta.status)}).`,
            });

            return;
          }

          setCotacao({ kind: "ok", cotacao: corpo.cotacao, chave });
        } catch {
          if (!cancelada) setCotacao({ kind: "erro", mensagem: "Falha de conexão com a API." });
        }
      })();
    }, 700);

    return () => {
      cancelada = true;
      window.clearTimeout(espera);
    };
  }, [chave]);

  const freteMl = cotacao.kind === "ok" && cotacao.chave === chave ? cotacao.cotacao.custoVendedor : null;

  const resultado = useMemo(
    () =>
      valores.preco === null || valores.custo === null
        ? null
        : calcularPreco({
            plataforma,
            preco: valores.preco,
            custo: valores.custo,
            tipoAnuncio: tipo,
            freteMl,
          }),
    [plataforma, valores.preco, valores.custo, tipo, freteMl],
  );

  const tom = resultado?.ok === true ? tomDaMargem(resultado.margem, margemMinima) : "neutro";
  const faixa = valores.preco === null ? null : faixaShopee(valores.preco);

  return (
    <section id="calculadora" className="sb-calc" aria-label="Calculadora de preço">
      <header className="sb-calc-cabecalho">
        <div>
          <span className="sb-calc-sobrancelha">Simulação</span>
          <h2>Calculadora de preço</h2>
          <p>Informe custo, preço e, no Mercado Livre, as medidas. A margem sai na hora.</p>
        </div>

        <div className="sb-calc-plataformas" role="radiogroup" aria-label="Plataforma">
          {(
            [
              ["mercado_livre", "Mercado Livre"],
              ["shopee", "Shopee"],
            ] as const
          ).map(([valor, rotulo]) => (
            <button
              key={valor}
              type="button"
              role="radio"
              aria-checked={plataforma === valor}
              className={plataforma === valor ? "sb-segmented-opcao sb-segmented-opcao-ativa" : "sb-segmented-opcao"}
              onClick={() => {
                setPlataforma(valor);
              }}
            >
              {rotulo}
            </button>
          ))}
        </div>
      </header>

      <div className="sb-calc-corpo">
        <div className="sb-calc-entradas">
          <div className="sb-calc-grupo">
            <label className="sb-calc-campo">
              <span>Custo do produto</span>
              <div className="sb-calc-moeda">
                <i>R$</i>
                <input className="sb-input" inputMode="decimal" placeholder="0,00" value={custo} onChange={(e) => { setCusto(e.target.value); }} />
              </div>
            </label>
            <label className="sb-calc-campo">
              <span>Preço de venda</span>
              <div className="sb-calc-moeda">
                <i>R$</i>
                <input className="sb-input" inputMode="decimal" placeholder="0,00" value={preco} onChange={(e) => { setPreco(e.target.value); }} />
              </div>
            </label>
          </div>

          {plataforma === "mercado_livre" ? (
            <>
              <div className="sb-calc-grupo">
                <div className="sb-calc-campo">
                  <span>Tipo de anúncio</span>
                  <div className="sb-calc-segmento" role="radiogroup" aria-label="Tipo de anúncio">
                    {(["classico", "premium"] as const).map((valor) => (
                      <button
                        key={valor}
                        type="button"
                        role="radio"
                        aria-checked={tipo === valor}
                        className={tipo === valor ? "sb-segmented-opcao sb-segmented-opcao-ativa" : "sb-segmented-opcao"}
                        onClick={() => {
                          setTipo(valor);
                        }}
                      >
                        {valor === "classico" ? "Clássico" : "Premium"} <small>{formatPercent(COMISSAO_ML[valor])}</small>
                      </button>
                    ))}
                  </div>
                </div>

                <label className="sb-calc-campo">
                  <span>Logística</span>
                  <select className="sb-input" value={logistica} onChange={(e) => { setLogistica(e.target.value as Logistica); }}>
                    {LOGISTICAS.map((l) => (
                      <option key={l.valor} value={l.valor}>
                        {l.rotulo}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {contas.length > 1 && (
                <label className="sb-calc-campo">
                  <span>Conta (a cotação usa a reputação e a logística dela)</span>
                  <select className="sb-input" value={contaId} onChange={(e) => { setContaId(e.target.value); }}>
                    {contas.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <fieldset className="sb-calc-medidas">
                <legend>Medidas da embalagem</legend>
                {(
                  [
                    ["Altura", "cm", altura, setAltura],
                    ["Largura", "cm", largura, setLargura],
                    ["Comprimento", "cm", comprimento, setComprimento],
                    ["Peso", "g", peso, setPeso],
                  ] as const
                ).map(([rotulo, unidade, valor, definir]) => (
                  <label key={rotulo} className="sb-calc-campo">
                    <span>{rotulo}</span>
                    <div className="sb-calc-unidade">
                      <input className="sb-input" inputMode="decimal" placeholder="0" value={valor} onChange={(e) => { definir(e.target.value); }} />
                      <i>{unidade}</i>
                    </div>
                  </label>
                ))}
              </fieldset>

              <p className={`sb-calc-frete sb-calc-frete-${cotacao.kind}`} aria-live="polite">
                {contas.length === 0
                  ? "Nenhuma conta do Mercado Livre conectada — sem conta, não há cotação de frete."
                  : valores.preco !== null && valores.preco < FRETE_GRATIS_ML_MINIMO
                    ? `Abaixo de ${formatCurrency(FRETE_GRATIS_ML_MINIMO)} o frete é do comprador — não entra na conta.`
                    : !medidasOk
                      ? "Preencha altura, largura, comprimento e peso para cotar o frete."
                      : cotacao.kind === "cotando"
                        ? "Cotando o frete com o Mercado Livre…"
                        : cotacao.kind === "erro"
                          ? cotacao.mensagem
                          : cotacao.kind === "ok"
                            ? `Frete cotado: ${formatCurrency(cotacao.cotacao.custoVendedor)}${cotacao.cotacao.pesoFaturavelG === null ? "" : ` · peso faturável ${String(cotacao.cotacao.pesoFaturavelG)} g`}${cotacao.cotacao.descontoPercentual === null ? "" : ` · desconto de ${formatPercent(cotacao.cotacao.descontoPercentual)}`}`
                            : "Aguardando o preço para cotar o frete."}
              </p>
            </>
          ) : (
            <div className="sb-calc-faixas">
              <span>Tarifas da Shopee por faixa de preço (percentual + valor fixo do frete)</span>
              <ul>
                {[...FAIXAS_SHOPEE].reverse().map((f, indice, lista) => {
                  const proxima = lista[indice + 1];
                  const rotulo =
                    proxima === undefined
                      ? `a partir de ${formatCurrency(f.desde)}`
                      : f.desde === 0
                        ? `até ${formatCurrency(proxima.desde - 0.01)}`
                        : `${formatCurrency(f.desde)} a ${formatCurrency(proxima.desde - 0.01)}`;

                  return (
                    <li key={f.desde} className={faixa?.desde === f.desde ? "sb-calc-faixa-ativa" : undefined}>
                      <b>{rotulo}</b>
                      <span>
                        {formatPercent(f.percentual)} + {formatCurrency(f.fixo)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>

        <aside className={`sb-calc-resultado sb-calc-tom-${tom}`} aria-live="polite">
          <span className="sb-calc-sobrancelha">Margem</span>

          {resultado === null ? (
            <p className="sb-calc-vazio">Informe custo e preço de venda.</p>
          ) : !resultado.ok ? (
            <p className="sb-calc-vazio">{resultado.motivo[0]?.toUpperCase()}{resultado.motivo.slice(1)}.</p>
          ) : (
            <>
              <strong className="sb-calc-margem">{formatPercent(resultado.margem)}</strong>
              <span className="sb-calc-lucro">
                {resultado.resultado >= 0 ? "sobram" : "faltam"} <b>{formatCurrency(Math.abs(resultado.resultado))}</b> por venda
              </span>

              <dl className="sb-calc-conta">
                <div>
                  <dt>Preço de venda</dt>
                  <dd>{formatCurrency(resultado.preco)}</dd>
                </div>
                {resultado.linhas.slice(0, 2).map((linha) => (
                  <div key={linha.rotulo} title={linha.detalhe}>
                    <dt>
                      − {linha.rotulo}
                      <small>{linha.detalhe}</small>
                    </dt>
                    <dd>{formatCurrency(linha.valor)}</dd>
                  </div>
                ))}
                <div className="sb-calc-subtotal">
                  <dt>= Você recebe</dt>
                  <dd>{formatCurrency(resultado.recebido)}</dd>
                </div>
                <div>
                  <dt>− Custo do produto</dt>
                  <dd>{formatCurrency(resultado.custo)}</dd>
                </div>
                <div className="sb-calc-total">
                  <dt>= Resultado</dt>
                  <dd>{formatCurrency(resultado.resultado)}</dd>
                </div>
              </dl>

              <small className="sb-calc-nota">
                Margem = resultado ÷ preço de venda. Não inclui impostos, Ads nem parcelamento
                {plataforma === "mercado_livre" ? "; o frete é a estimativa do Mercado Livre para uma unidade." : "."}
              </small>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
