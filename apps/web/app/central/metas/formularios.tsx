"use client";

import { useActionState, useId, type ReactNode } from "react";

import { salvarAliquota, salvarMeta, type ResultadoDoCadastro } from "./actions";

const INICIAL: ResultadoDoCadastro = { ok: false, mensagem: null, erros: {} };

/**
 * Um campo do cadastro: rótulo, entrada, dica e erro SEPARADOS — a dica chega
 * pelo `aria-describedby`, como em `reposicao/configuracoes/gaveta-regra.tsx`,
 * para o nome acessível do campo continuar sendo o rótulo.
 */
function Campo({
  nome,
  rotulo,
  dica,
  erro,
  children,
}: {
  nome: string;
  rotulo: string;
  dica: string;
  erro: string | undefined;
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
      {erro !== undefined && (
        <p id={idErro} role="alert" className="sb-campo-erro" data-campo={nome}>
          {erro}
        </p>
      )}
    </div>
  );
}

function Mensagem({ resultado }: { resultado: ResultadoDoCadastro }): ReactNode {
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
      <Campo nome="month" rotulo="Mês" dica="A meta vale para o mês inteiro." erro={resultado.erros.month}>
        {(props) => <input {...props} className="sb-input" type="month" name="month" defaultValue={mesPadrao} required />}
      </Campo>

      <Campo
        nome="revenue_goal"
        rotulo="Meta de faturamento (R$)"
        dica="Receita bruta das vendas válidas, todas as contas. Ex.: 2.800.000"
        erro={resultado.erros.revenue_goal}
      >
        {(props) => <input {...props} className="sb-input" name="revenue_goal" inputMode="decimal" required />}
      </Campo>

      <Campo nome="note" rotulo="Nota (opcional)" dica="Até 300 caracteres." erro={resultado.erros.note}>
        {(props) => <input {...props} className="sb-input" name="note" maxLength={300} />}
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

export function FormularioAliquota({ dataPadrao }: { dataPadrao: string }): ReactNode {
  const [resultado, enviar, salvando] = useActionState(salvarAliquota, INICIAL);

  return (
    <form action={enviar} className="sb-cadastro-form" aria-label="Cadastrar alíquota de imposto">
      <Campo
        nome="valid_from"
        rotulo="Vale a partir de"
        dica="Vale até a próxima vigência cadastrada. Para o histórico, use uma data antiga."
        erro={resultado.erros.valid_from}
      >
        {(props) => (
          <input {...props} className="sb-input" type="date" name="valid_from" defaultValue={dataPadrao} required />
        )}
      </Campo>

      <Campo
        nome="rate"
        rotulo="Alíquota efetiva (%)"
        dica="Sobre o faturamento bruto. Ex.: 6,5"
        erro={resultado.erros.rate}
      >
        {(props) => <input {...props} className="sb-input" name="rate" inputMode="decimal" required />}
      </Campo>

      <Campo nome="note" rotulo="Nota (opcional)" dica="Ex.: Simples Nacional, anexo I." erro={resultado.erros.note}>
        {(props) => <input {...props} className="sb-input" name="note" maxLength={300} />}
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
