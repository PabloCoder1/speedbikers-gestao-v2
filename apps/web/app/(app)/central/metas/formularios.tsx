"use client";

import { useActionState, useId, type ReactNode } from "react";

import { Ajuda } from "../../../../components/ajuda";

import { salvarAliquota, salvarMeta, salvarMetaDoMarketplace, type ResultadoDoCadastro } from "./actions";

const INICIAL: ResultadoDoCadastro = { ok: false, mensagem: null, erros: {} };

/**
 * Um campo do cadastro: rótulo, entrada, dica e erro SEPARADOS — a dica chega
 * pelo `aria-describedby`, como em `reposicao/configuracoes/gaveta-regra.tsx`,
 * para o nome acessível do campo continuar sendo o rótulo.
 *
 * `ajuda` é a explicação do termo, a um toque (`Ajuda`, UX_SYSTEM §6, bloco 2):
 * fica FORA do rótulo, para o nome do campo não mudar.
 */
export function Campo({
  nome,
  rotulo,
  dica,
  erro,
  ajuda,
  children,
}: {
  nome: string;
  rotulo: string;
  dica: string;
  erro: string | undefined;
  ajuda?: { readonly pergunta: string; readonly texto: ReactNode };
  children: (props: { id: string; "aria-invalid"?: true; "aria-describedby": string }) => ReactNode;
}): ReactNode {
  const id = useId();
  const idDica = `${id}-dica`;
  const idErro = `${id}-erro`;

  return (
    <div className="sb-form-campo">
      <label htmlFor={id}>{rotulo}</label>
      {children({
        id,
        ...(erro === undefined ? {} : { "aria-invalid": true as const }),
        "aria-describedby": erro === undefined ? idDica : `${idDica} ${idErro}`,
      })}
      <small id={idDica}>{dica}</small>
      {ajuda !== undefined && <Ajuda pergunta={ajuda.pergunta}>{ajuda.texto}</Ajuda>}
      {erro !== undefined && (
        <p id={idErro} role="alert" className="sb-campo-erro" data-campo={nome}>
          {erro}
        </p>
      )}
    </div>
  );
}

export function Mensagem({ resultado }: { resultado: ResultadoDoCadastro }): ReactNode {
  if (resultado.mensagem === null) return null;

  return (
    <p role={resultado.ok ? "status" : "alert"} className={resultado.ok ? "sb-cadastro-ok" : "sb-campo-erro"}>
      {resultado.mensagem}
    </p>
  );
}

export function FormularioMeta({ mesPadrao }: { mesPadrao: string }): ReactNode {
  const [resultado, enviar, salvando] = useActionState(salvarMeta, INICIAL);

  return (
    <form action={enviar} className="sb-cadastro-form" aria-label="Cadastrar meta do mês">
      <p className="sb-form-legenda">Todos os campos são obrigatórios, menos os marcados como opcionais.</p>
      <Campo nome="month" rotulo="Mês" dica="A meta vale para o mês inteiro." erro={resultado.erros.month}>
        {(props) => <input {...props} className="sb-input" type="month" name="month" defaultValue={mesPadrao} required />}
      </Campo>

      <Campo
        nome="revenue_goal"
        rotulo="Meta de faturamento (R$)"
        dica="Receita bruta das vendas válidas, todas as contas e marketplaces. Ex.: 2.800.000"
        erro={resultado.erros.revenue_goal}
        ajuda={{
          pergunta: "O que conta para a meta?",
          texto: (
            <>
              <p>
                A receita bruta das vendas válidas do mês (pagas ou com reembolso parcial), pelo dia da venda, de todas as
                contas do Mercado Livre e das lojas Shopee reais. A Shopee só passa a somar depois da primeira leitura de
                pedidos de uma loja real.
              </p>
              <p>
                Escreva em reais, com ou sem pontos de milhar (2.800.000 ou 2800000), e os centavos depois da vírgula.
                Cadastrar de novo o mesmo mês troca a meta dele.
              </p>
            </>
          ),
        }}
      >
        {(props) => <input {...props} className="sb-input" name="revenue_goal" inputMode="decimal" required />}
      </Campo>

      <Campo
        nome="note"
        rotulo="Observação (opcional)"
        dica="Aparece na lista, para identificar ou explicar esta meta. Até 300 caracteres."
        erro={resultado.erros.note}
      >
        {(props) => (
          <input {...props} className="sb-input" name="note" maxLength={300} placeholder="Ex.: meta com a campanha de aniversário" />
        )}
      </Campo>

      <div className="sb-cadastro-acoes">
        <button type="submit" className="sb-button sb-button-primary" disabled={salvando}>
          {salvando ? "Salvando…" : "Salvar meta"}
        </button>
        <Mensagem resultado={resultado} />
      </div>
    </form>
  );
}

/** A meta de um marketplace (D-473, C-66), ao lado da geral. */
export function FormularioMetaDoMarketplace({ mesPadrao }: { mesPadrao: string }): ReactNode {
  const [resultado, enviar, salvando] = useActionState(salvarMetaDoMarketplace, INICIAL);

  return (
    <form action={enviar} className="sb-cadastro-form" aria-label="Cadastrar meta por marketplace">
      <p className="sb-form-legenda">Todos os campos são obrigatórios, menos os marcados como opcionais.</p>
      <Campo
        nome="marketplace"
        rotulo="Marketplace"
        dica="A meta compara só a receita deste marketplace."
        erro={resultado.erros.marketplace}
      >
        {(props) => (
          <select {...props} className="sb-input" name="marketplace" defaultValue="ML" required>
            <option value="ML">Mercado Livre</option>
            <option value="SHOPEE">Shopee</option>
          </select>
        )}
      </Campo>

      <Campo nome="month" rotulo="Mês" dica="A meta vale para o mês inteiro." erro={resultado.erros.month}>
        {(props) => <input {...props} className="sb-input" type="month" name="month" defaultValue={mesPadrao} required />}
      </Campo>

      <Campo
        nome="revenue_goal"
        rotulo="Meta do marketplace (R$)"
        dica="Receita bruta das vendas válidas do marketplace. Ex.: 1.500.000"
        erro={resultado.erros.revenue_goal}
        ajuda={{
          pergunta: "Como a meta do marketplace se relaciona com a geral?",
          texto: (
            <p>
              Cada marketplace é medido contra a meta dele, e a meta geral é medida contra a soma dos dois. O sistema não
              exige que as metas dos marketplaces somem a geral: cadastre o que fizer sentido para cada um. Cadastrar de
              novo o mesmo mês e marketplace troca a meta.
            </p>
          ),
        }}
      >
        {(props) => <input {...props} className="sb-input" name="revenue_goal" inputMode="decimal" required />}
      </Campo>

      <Campo
        nome="note"
        rotulo="Observação (opcional)"
        dica="Aparece na lista, para identificar ou explicar esta meta. Até 300 caracteres."
        erro={resultado.erros.note}
      >
        {(props) => (
          <input {...props} className="sb-input" name="note" maxLength={300} placeholder="Ex.: meta com a campanha de aniversário" />
        )}
      </Campo>

      <div className="sb-cadastro-acoes">
        <button type="submit" className="sb-button sb-button-primary" disabled={salvando}>
          {salvando ? "Salvando…" : "Salvar meta do marketplace"}
        </button>
        <Mensagem resultado={resultado} />
      </div>
    </form>
  );
}

export function FormularioAliquota({ dataPadrao }: { dataPadrao: string }): ReactNode {
  const [resultado, enviar, salvando] = useActionState(salvarAliquota, INICIAL);

  return (
    <form action={enviar} className="sb-cadastro-form" aria-label="Cadastrar alíquota de imposto">
      <p className="sb-form-legenda">Todos os campos são obrigatórios, menos os marcados como opcionais.</p>
      <Campo
        nome="valid_from"
        rotulo="Vale a partir de"
        dica="Vale até a próxima vigência cadastrada. Para o histórico, use uma data antiga."
        erro={resultado.erros.valid_from}
        ajuda={{
          pergunta: "Como funciona a vigência?",
          texto: (
            <>
              <p>
                A alíquota vale do dia escolhido até a véspera da próxima cadastrada; a mais recente vale sem data de fim.
                Para registrar uma mudança, cadastre a nova alíquota com o dia em que ela passou a valer: a anterior
                continua valendo nos dias dela.
              </p>
              <p>
                Vendas de dias antes da primeira alíquota ficam sem imposto, e o imposto e o lucro após imposto desse
                período aparecem em branco na central, nunca pela metade.
              </p>
            </>
          ),
        }}
      >
        {(props) => (
          <input {...props} className="sb-input" type="date" name="valid_from" defaultValue={dataPadrao} required />
        )}
      </Campo>

      <Campo
        nome="rate"
        rotulo="Alíquota efetiva (%)"
        dica="Percentual sobre o faturamento bruto, de 0 a 99,999. Ex.: 6,5"
        erro={resultado.erros.rate}
        ajuda={{
          pergunta: "O que é a alíquota efetiva?",
          texto: (
            <>
              <p>
                É o percentual que o imposto representa, na prática, sobre o faturamento bruto da empresa. O sistema
                multiplica a receita de cada pedido pela alíquota que vale no dia da venda para estimar o imposto e o lucro
                após imposto e Ads, na central, no faturamento e no ranking de produtos.
              </p>
              <p>
                É uma estimativa, não a apuração da guia: use a alíquota efetiva que a contabilidade informar. Escreva só o
                número (6,5 para 6,5%). Zero vale como sem imposto, e não como alíquota faltando.
              </p>
            </>
          ),
        }}
      >
        {(props) => <input {...props} className="sb-input" name="rate" inputMode="decimal" required />}
      </Campo>

      <Campo
        nome="note"
        rotulo="Observação (opcional)"
        dica="O regime ou a origem da alíquota, para quem consultar depois. Até 300 caracteres."
        erro={resultado.erros.note}
      >
        {(props) => (
          <input {...props} className="sb-input" name="note" maxLength={300} placeholder="Ex.: Simples Nacional, anexo I" />
        )}
      </Campo>

      <div className="sb-cadastro-acoes">
        <button type="submit" className="sb-button sb-button-primary" disabled={salvando}>
          {salvando ? "Salvando…" : "Salvar alíquota"}
        </button>
        <Mensagem resultado={resultado} />
      </div>
    </form>
  );
}
