"use client";

import Link from "next/link";
import { useActionState, useId, useState, useTransition, type ReactNode } from "react";

import { Drawer } from "../../../components/drawer";
import { formatCount } from "../../../lib/format";
import { governadosPelaRegra, novosCobertos, type Alcance } from "../../../lib/replenishment-reach";
import { fraseDaRegra, validarRegra, type CampoDaRegra } from "../../../lib/replenishment-rule";

import { removerRegra, salvarRegra, type ResultadoDaRegra } from "./actions";
import { avisar } from "./aviso";
import { ReguaPolitica } from "./regua-politica";

/**
 * A GAVETA DA REGRA (D-361) — criar e editar uma regra de reposição.
 *
 * Substitui os quatro campos soltos numa linha de tabela e o formulário
 * horizontal de D-144. A ordem é a das perguntas de quem configura:
 *
 * 1. **para quem** — o escopo (padrão da organização ou marca), com quantos SKUs
 *    ele alcança; na edição ele é identidade e não muda (D-076);
 * 2. **os números**, na ordem da régua: prazo, segurança, cobertura, teto;
 * 3. **o que eles fazem** — a régua redesenhada a cada tecla e a frase de
 *    operação, com os tons que `/reposicao` vai usar;
 * 4. **quanto muda** — quantos SKUs passam a ter sugestão, antes de salvar.
 *
 * Remover fica no fim e pede confirmação dizendo PARA ONDE os SKUs vão: "passam
 * a usar o padrão" e "ficam sem sugestão" são consequências diferentes, e a
 * versão de D-144 removia no primeiro clique sem dizer nenhuma.
 *
 * ## As referências são botões, não valores de fábrica
 *
 * D-144 recusa pré-preencher: "referência é o que o ADMIN digita, não o que o
 * código assume". Continua assim — os campos abrem vazios na criação. As
 * referências do PRD (~15 dias de prazo nacional, ~90 de cobertura para
 * importação) viram atalhos que só preenchem quando clicados: é o ADMIN quem
 * escolhe, com um clique em vez de lembrar o número.
 *
 * A validação roda aqui (para o erro aparecer antes de enviar) e de novo na
 * Server Action; o banco é a trava.
 */

export interface RegraExistente {
  readonly id: string;
  readonly marca: string | null;
  readonly skuId: string | null;
  readonly skuCodigo: string | null;
  readonly prazo: number;
  readonly cobertura: number;
  readonly seguranca: number;
  readonly teto: number | null;
  readonly nota: string | null;
}

export interface OpcaoDeEscopo {
  readonly marca: string;
  readonly naReposicao: number;
  readonly comVenda30d: number;
  readonly temRegra: boolean;
}

const RESULTADO_INICIAL: ResultadoDaRegra = { ok: false, mensagem: null, erros: {} };

function rotuloDoEscopo(regra: RegraExistente): string {
  if (regra.skuId !== null) return `SKU ${regra.skuCodigo ?? regra.skuId}`;
  if (regra.marca !== null) return `Marca ${regra.marca}`;

  return "Padrão da organização";
}

function skus(n: number): string {
  return `${formatCount(n)} ${n === 1 ? "SKU" : "SKUs"}`;
}

export function AbrirRegra({
  rotulo,
  variante = "secundario",
  regra,
  marcaInicial,
  opcoes,
  padraoExiste,
  alcance,
}: {
  rotulo: string;
  variante?: "primario" | "secundario" | "texto";
  /** Presente = edição. */
  regra?: RegraExistente;
  /** Na criação: "" abre no padrão, uma marca abre nela. */
  marcaInicial?: string;
  opcoes: readonly OpcaoDeEscopo[];
  padraoExiste: boolean;
  /** Nulo quando a leitura do alcance falhou: a gaveta funciona sem os números. */
  alcance: Alcance | null;
}): ReactNode {
  const [aberta, setAberta] = useState(false);

  return (
    <>
      <button
        type="button"
        className={
          variante === "primario" ? "sb-button sb-button-primary" : variante === "texto" ? "sb-text-button" : "sb-button"
        }
        onClick={() => {
          setAberta(true);
        }}
      >
        {rotulo}
      </button>

      {aberta && (
        <GavetaRegra
          regra={regra}
          marcaInicial={marcaInicial ?? ""}
          opcoes={opcoes}
          padraoExiste={padraoExiste}
          alcance={alcance}
          onClose={() => {
            setAberta(false);
          }}
          onConcluir={(mensagem) => {
            setAberta(false);
            avisar(mensagem);
          }}
        />
      )}
    </>
  );
}

function GavetaRegra({
  regra,
  marcaInicial,
  opcoes,
  padraoExiste,
  alcance,
  onClose,
  onConcluir,
}: {
  regra: RegraExistente | undefined;
  marcaInicial: string;
  opcoes: readonly OpcaoDeEscopo[];
  padraoExiste: boolean;
  alcance: Alcance | null;
  onClose: () => void;
  onConcluir: (mensagem: string) => void;
}): ReactNode {
  const formId = useId();
  const editando = regra !== undefined;

  const [escopo, setEscopo] = useState(regra?.marca ?? marcaInicial);
  const [prazo, setPrazo] = useState(regra === undefined ? "" : String(regra.prazo));
  const [seguranca, setSeguranca] = useState(regra === undefined ? "" : String(regra.seguranca));
  const [cobertura, setCobertura] = useState(regra === undefined ? "" : String(regra.cobertura));
  const [teto, setTeto] = useState(regra?.teto === null || regra === undefined ? "" : String(regra.teto));
  const [nota, setNota] = useState(regra?.nota ?? "");
  // Os erros de campo só aparecem depois da primeira tentativa de salvar: um
  // campo vazio gritando "obrigatório" antes de ser tocado é ruído.
  const [tentou, setTentou] = useState(false);

  const [confirmandoRemocao, setConfirmandoRemocao] = useState(false);
  const [erroRemocao, setErroRemocao] = useState<string | null>(null);
  const [removendo, iniciarRemocao] = useTransition();

  const [resultado, enviar, salvando] = useActionState(async (anterior: ResultadoDaRegra, dados: FormData) => {
    const r = await salvarRegra(anterior, dados);

    if (r.ok) onConcluir(r.mensagem ?? "Regra salva.");

    return r;
  }, RESULTADO_INICIAL);

  const validacao = validarRegra({ prazo, cobertura, seguranca, teto, nota });
  const errosLocais = validacao.ok || !tentou ? {} : validacao.erros;
  const erros: Partial<Record<CampoDaRegra | "supplier_brand", string>> = { ...resultado.erros, ...errosLocais };

  // A régua só aparece com os três números que a definem — com um campo vazio
  // ela desenharia uma política que ninguém configurou.
  const numeros = validarRegra({ prazo, cobertura, seguranca, teto: "", nota: "" });
  const tetoDigitado = validacao.ok ? validacao.valores.teto : null;

  const escopoDaConta: { tipo: "PADRAO" } | { tipo: "MARCA"; marca: string } =
    escopo === "" ? { tipo: "PADRAO" } : { tipo: "MARCA", marca: escopo };

  const titulo = editando ? rotuloDoEscopo(regra) : "Nova regra de reposição";

  function campo(
    nome: CampoDaRegra,
    rotuloDoCampo: string,
    dica: string,
    valor: string,
    mudar: (v: string) => void,
    extra: { opcional?: boolean; min: number; max: number },
  ): ReactNode {
    const idCampo = `${formId}-${nome}`;
    const idDica = `${idCampo}-dica`;
    const idErro = `${idCampo}-erro`;
    const erro = erros[nome];

    // Rótulo, campo e dica SEPARADOS: com a dica dentro do `<label>`, o nome
    // acessível do campo virava a frase inteira. A dica chega pelo
    // `aria-describedby`, que é o lugar dela.
    return (
      <div className="sb-form-campo sb-cfg-campo">
        <label htmlFor={idCampo}>
          {rotuloDoCampo}
          {extra.opcional === true && <em> · opcional</em>}
        </label>
        <span className="sb-cfg-campo-dias">
          <input
            id={idCampo}
            className="sb-input"
            name={nome}
            type="number"
            inputMode="numeric"
            min={extra.min}
            max={extra.max}
            step={1}
            value={valor}
            aria-invalid={erro === undefined ? undefined : true}
            aria-describedby={erro === undefined ? idDica : `${idDica} ${idErro}`}
            onChange={(e) => {
              mudar(e.target.value);
            }}
          />
          <span aria-hidden="true">dias</span>
        </span>
        <small id={idDica}>{dica}</small>
        {erro !== undefined && (
          <p id={idErro} role="alert" className="sb-campo-erro">
            {erro}
          </p>
        )}
      </div>
    );
  }

  const impacto = ((): ReactNode => {
    if (alcance === null) return null;

    if (editando) {
      if (regra.skuId !== null) return null;

      const g = governadosPelaRegra(alcance, escopoDaConta);

      return (
        <p className="sb-cfg-impacto">
          Esta regra governa <b>{skus(g.skus)}</b> da reposição ({formatCount(g.comVenda)} com venda nos últimos 30 dias).
        </p>
      );
    }

    const n = novosCobertos(alcance, escopoDaConta);
    const opcao = opcoes.find((o) => o.marca === escopo);

    if (escopo !== "" && n.skus === 0 && opcao !== undefined && opcao.naReposicao > 0) {
      return (
        <p className="sb-cfg-impacto">
          {escopo} hoje usa o padrão da organização. A regra própria troca os números para{" "}
          <b>{skus(opcao.naReposicao)}</b> — sem mudar quem tem sugestão.
        </p>
      );
    }

    if (n.skus === 0) {
      return <p className="sb-cfg-impacto">Nenhum SKU desse escopo está na reposição hoje.</p>;
    }

    return (
      <p className="sb-cfg-impacto sb-cfg-impacto-ganho">
        Passam a ter política <b>{skus(n.skus)}</b> da reposição — <b>{formatCount(n.comVenda)}</b> com venda nos últimos
        30 dias.
      </p>
    );
  })();

  // Montada, não derivada do título: `titulo.toLowerCase()` levava a marca junto
  // ("Remover marca navetec?"), e marca é nome próprio em caixa alta (D-133).
  const perguntaDeRemocao =
    regra === undefined
      ? ""
      : regra.skuId !== null
        ? `Remover a regra do SKU ${regra.skuCodigo ?? regra.skuId}?`
        : regra.marca !== null
          ? `Remover a regra da marca ${regra.marca}?`
          : "Remover o padrão da organização?";

  const consequenciaDaRemocao = ((): string => {
    if (regra === undefined || alcance === null || regra.skuId !== null) {
      return "O escopo desta regra passa a seguir a próxima regra aplicável, ou fica sem sugestão.";
    }

    const g = governadosPelaRegra(alcance, escopoDaConta);

    if (g.skus === 0) return "Nenhum SKU da reposição usa esta regra hoje.";

    return g.destinoSemEla === "PADRAO"
      ? `${skus(g.skus)} passam a usar o padrão da organização.`
      : `${skus(g.skus)} ficam sem sugestão de compra (${formatCount(g.comVenda)} com venda recente).`;
  })();

  return (
    <Drawer
      eyebrow={editando ? "EDITAR REGRA DE REPOSIÇÃO" : "NOVA REGRA DE REPOSIÇÃO"}
      label={titulo}
      onClose={onClose}
      chao
      footer={
        confirmandoRemocao ? (
          <div className="sb-cfg-confirmar" role="alertdialog" aria-label="Confirmar remoção da regra">
            <p>
              <b>{perguntaDeRemocao}</b> {consequenciaDaRemocao}
            </p>
            {erroRemocao !== null && (
              <p role="alert" className="sb-campo-erro">
                {erroRemocao}
              </p>
            )}
            <div className="sb-cfg-confirmar-acoes">
              <button
                type="button"
                className="sb-button"
                disabled={removendo}
                onClick={() => {
                  setConfirmandoRemocao(false);
                }}
              >
                Manter a regra
              </button>
              <button
                type="button"
                className="sb-button sb-button-danger"
                disabled={removendo}
                onClick={() => {
                  setErroRemocao(null);
                  iniciarRemocao(async () => {
                    const r = await removerRegra(regra?.id ?? "");

                    if (r.ok) onConcluir(r.mensagem);
                    else setErroRemocao(r.mensagem);
                  });
                }}
              >
                {removendo ? "Removendo…" : "Sim, remover"}
              </button>
            </div>
          </div>
        ) : (
          <div className="sb-cfg-rodape">
            {editando && (
              <button
                type="button"
                className="sb-text-button sb-cfg-remover"
                onClick={() => {
                  setConfirmandoRemocao(true);
                }}
              >
                Remover regra
              </button>
            )}
            <button type="button" className="sb-button" onClick={onClose} disabled={salvando}>
              Cancelar
            </button>
            <button
              type="submit"
              form={formId}
              className="sb-button sb-button-primary"
              disabled={salvando}
              onClick={() => {
                setTentou(true);
              }}
            >
              {salvando ? "Salvando…" : editando ? "Salvar alterações" : "Criar regra"}
            </button>
          </div>
        )
      }
    >
      <form
        id={formId}
        action={enviar}
        className="sb-cfg-form"
        noValidate
        onSubmit={(event) => {
          setTentou(true);

          // Com erro local, nem vai ao servidor: a frase já está no campo.
          if (!validarRegra({ prazo, cobertura, seguranca, teto, nota }).ok) event.preventDefault();
        }}
      >
        {editando && <input type="hidden" name="id" value={regra.id} />}

        <h2 className="sb-cfg-gaveta-titulo">{titulo}</h2>

        {resultado.mensagem !== null && !resultado.ok && (
          <p role="alert" className="sb-note sb-note-perigo sb-cfg-mensagem">
            {resultado.mensagem}
          </p>
        )}

        <section className="sb-form-secao">
          <span className="sb-form-secao-titulo">Para quem</span>

          {editando ? (
            <p className="sb-cfg-escopo-fixo">
              <b>{titulo}</b>
              <small>O escopo não muda depois de criado: para outra marca, crie outra regra.</small>
            </p>
          ) : (
            <label className="sb-form-campo">
              <span>Escopo</span>
              <select
                className="sb-input"
                name="supplier_brand"
                value={escopo}
                aria-invalid={erros.supplier_brand === undefined ? undefined : true}
                onChange={(e) => {
                  setEscopo(e.target.value);
                }}
              >
                <option value="" disabled={padraoExiste}>
                  Padrão da organização{padraoExiste ? " (já existe)" : " — vale para toda marca sem regra"}
                </option>
                <optgroup label="Por marca do fornecedor">
                  {opcoes.map((o) => (
                    <option key={o.marca} value={o.marca} disabled={o.temRegra}>
                      {o.marca} — {o.temRegra ? "já tem regra" : `${formatCount(o.naReposicao)} na reposição`}
                    </option>
                  ))}
                </optgroup>
              </select>
              <small>O mais específico vence: a regra da marca sobrepõe o padrão.</small>
              {erros.supplier_brand !== undefined && (
                <p role="alert" className="sb-campo-erro">
                  {erros.supplier_brand}
                </p>
              )}
            </label>
          )}

          {impacto}
        </section>

        <section className="sb-form-secao">
          <span className="sb-form-secao-titulo">A política</span>

          <div className="sb-cfg-referencias" aria-label="Referências da operação">
            <span>Referências:</span>
            <button
              type="button"
              className="sb-text-button"
              onClick={() => {
                setPrazo("15");
              }}
            >
              nacional · prazo 15 dias
            </button>
            <button
              type="button"
              className="sb-text-button"
              onClick={() => {
                setCobertura("90");
              }}
            >
              importação · cobertura 90 dias
            </button>
          </div>

          <div className="sb-cfg-campos">
            {campo(
              "lead_time_days",
              "Prazo do fornecedor",
              "Do pedido até o produto chegar.",
              prazo,
              setPrazo,
              { min: 1, max: 365 },
            )}
            {campo(
              "safety_stock_days",
              "Segurança",
              "Margem para atraso ou pico de venda. Vazio = 0.",
              seguranca,
              setSeguranca,
              { min: 0, max: 365 },
            )}
            {campo(
              "target_coverage_days",
              "Cobertura desejada",
              "Quantos dias de venda a compra deve durar depois de chegar.",
              cobertura,
              setCobertura,
              { min: 1, max: 365 },
            )}
            {campo(
              "max_coverage_days",
              "Teto de cobertura",
              "Acima disso é excesso. Vazio = excesso nunca é apontado.",
              teto,
              setTeto,
              { opcional: true, min: 1, max: 1095 },
            )}
          </div>

          {numeros.ok ? (
            <div className="sb-cfg-previa" aria-live="polite">
              <ReguaPolitica
                prazo={numeros.valores.prazo}
                cobertura={numeros.valores.cobertura}
                seguranca={numeros.valores.seguranca}
                teto={tetoDigitado}
              />
              <p className="sb-cfg-frase">
                {fraseDaRegra({
                  prazo: numeros.valores.prazo,
                  cobertura: numeros.valores.cobertura,
                  seguranca: numeros.valores.seguranca,
                  teto: tetoDigitado,
                })}
              </p>
            </div>
          ) : (
            <p className="sb-cfg-previa-vazia">Preencha prazo e cobertura para ver o que a regra faz.</p>
          )}
        </section>

        <section className="sb-form-secao">
          <label className="sb-form-campo">
            <span>
              Nota <em>· opcional</em>
            </span>
            <textarea
              className="sb-input sb-cfg-nota"
              name="policy_note"
              rows={2}
              maxLength={500}
              value={nota}
              placeholder="Por que estes números? Ex.: fornecedor importa por navio, 60 dias de trânsito."
              onChange={(e) => {
                setNota(e.target.value);
              }}
            />
            {erros.policy_note !== undefined && (
              <p role="alert" className="sb-campo-erro">
                {erros.policy_note}
              </p>
            )}
          </label>
        </section>

        {escopo !== "" && !editando && (
          <p className="sb-cfg-rodape-nota">
            <Link href={`/reposicao?marca=${encodeURIComponent(escopo)}`}>Ver {escopo} na reposição</Link>
          </p>
        )}
      </form>
    </Drawer>
  );
}
