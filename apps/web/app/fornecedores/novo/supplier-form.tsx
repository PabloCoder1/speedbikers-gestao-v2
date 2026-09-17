"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";

import type { CampoFornecedor } from "../../../lib/supplier-form";
import { formatarDocumento } from "../../../lib/suppliers-overview";
import { salvarFornecedor } from "../actions";

/**
 * O formulário de fornecedor — cadastro e edição (D-366).
 *
 * Era uma coluna de nove campos iguais, sem dizer qual estava errado: o banco
 * recusava um nome repetido com "Não foi possível concluir a ação". Agora os
 * campos vêm em dois grupos (quem é, como falar), cada erro aparece no próprio
 * campo, e o teclado do celular é o do tipo do campo (e-mail, telefone, site).
 */

export interface ValoresFornecedor {
  name: string;
  legalName: string | null;
  document: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  website: string | null;
  notes: string | null;
}

interface Campo {
  nome: Exclude<CampoFornecedor, "notes">;
  rotulo: string;
  dica?: string;
  tipo?: "email" | "tel" | "url";
  autoComplete?: string;
  placeholder?: string;
  largo?: boolean;
}

const IDENTIFICACAO: readonly Campo[] = [
  {
    nome: "name",
    rotulo: "Nome",
    dica: "como a equipe chama o fornecedor",
    autoComplete: "organization",
    largo: true,
  },
  {
    nome: "legalName",
    rotulo: "Razão social",
    placeholder: "como está na nota fiscal",
  },
  {
    nome: "document",
    rotulo: "CNPJ ou CPF",
    placeholder: "00.000.000/0000-00",
  },
];

const CONTATO: readonly Campo[] = [
  {
    nome: "contactName",
    rotulo: "Pessoa de contato",
    autoComplete: "name",
    placeholder: "vendedor ou representante",
  },
  {
    nome: "email",
    rotulo: "E-mail",
    tipo: "email",
    autoComplete: "email",
    placeholder: "vendas@fornecedor.com.br",
  },
  {
    nome: "phone",
    rotulo: "Telefone",
    tipo: "tel",
    autoComplete: "tel",
    placeholder: "(11) 3333-4444",
  },
  {
    nome: "whatsapp",
    rotulo: "WhatsApp",
    tipo: "tel",
    placeholder: "(11) 98765-4321",
  },
  {
    nome: "website",
    rotulo: "Site",
    tipo: "url",
    autoComplete: "url",
    placeholder: "fornecedor.com.br",
    largo: true,
  },
];

export function SupplierForm({
  id = null,
  inicial = null,
}: {
  /** Nulo = cadastro novo. */
  id?: string | null;
  inicial?: ValoresFornecedor | null;
}): ReactNode {
  const router = useRouter();
  const [salvando, startTransition] = useTransition();
  const [erros, setErros] = useState<Partial<Record<CampoFornecedor, string>>>({});
  const [mensagem, setMensagem] = useState<string | null>(null);

  const destinoCancelar = id === null ? "/fornecedores" : `/fornecedores/${id}`;

  function enviar(formData: FormData): void {
    setMensagem(null);

    startTransition(async () => {
      const resultado = await salvarFornecedor(id, formData);

      if (!resultado.ok) {
        setErros(resultado.erros);
        setMensagem(resultado.mensagem);

        // Leva o foco ao primeiro campo recusado: com o formulário comprido, o
        // erro abaixo da dobra passaria por "cliquei e nada aconteceu".
        const primeiro = Object.keys(resultado.erros)[0];

        if (primeiro !== undefined) document.getElementById(`forn-${primeiro}`)?.focus();

        return;
      }

      setErros({});
      router.push(resultado.id === undefined ? "/fornecedores" : `/fornecedores/${resultado.id}`);
      router.refresh();
    });
  }

  function renderCampo(campo: Campo): ReactNode {
    const erro = erros[campo.nome];
    const valorInicial = inicial?.[campo.nome] ?? "";

    return (
      <label
        key={campo.nome}
        className={campo.largo === true ? "sb-form-campo sb-forn-campo-largo" : "sb-form-campo"}
        htmlFor={`forn-${campo.nome}`}
      >
        <span>
          {campo.rotulo}
          {campo.nome === "name" && <span className="sb-forn-obrigatorio"> obrigatório</span>}
        </span>
        <input
          id={`forn-${campo.nome}`}
          className="sb-input sb-input-full"
          name={campo.nome}
          type={campo.tipo === "url" ? "text" : (campo.tipo ?? "text")}
          inputMode={campo.tipo === "url" ? "url" : undefined}
          defaultValue={campo.nome === "document" ? (formatarDocumento(valorInicial || null) ?? "") : valorInicial}
          required={campo.nome === "name"}
          maxLength={campo.nome === "name" ? 200 : undefined}
          autoComplete={campo.autoComplete ?? "off"}
          placeholder={campo.placeholder}
          aria-invalid={erro === undefined ? undefined : true}
          aria-describedby={erro === undefined ? undefined : `forn-${campo.nome}-erro`}
          onBlur={
            campo.nome === "document"
              ? (evento) => {
                  const formatado = formatarDocumento(evento.currentTarget.value.trim() || null);

                  if (formatado !== null) evento.currentTarget.value = formatado;
                }
              : undefined
          }
        />
        {erro === undefined ? (
          campo.dica !== undefined && <small>{campo.dica}</small>
        ) : (
          <span id={`forn-${campo.nome}-erro`} className="sb-campo-erro" role="alert">
            {erro}
          </span>
        )}
      </label>
    );
  }

  return (
    <form
      className="sb-forn-form"
      noValidate
      /*
        `onSubmit`, e não `action`: no React 19 o `<form action>` REINICIA os
        campos não controlados ao terminar. Com erro de validação, o que a
        pessoa digitou sumia e o campo voltava ao valor salvo — ao lado de uma
        mensagem que já não descrevia o campo (visto na captura).
      */
      onSubmit={(evento) => {
        evento.preventDefault();
        enviar(new FormData(evento.currentTarget));
      }}
    >
      <section className="sb-form-secao" aria-labelledby="forn-secao-quem">
        <h2 id="forn-secao-quem" className="sb-form-secao-titulo">
          Quem é
        </h2>
        <div className="sb-forn-grade">{IDENTIFICACAO.map(renderCampo)}</div>
      </section>

      <section className="sb-form-secao" aria-labelledby="forn-secao-contato">
        <h2 id="forn-secao-contato" className="sb-form-secao-titulo">
          Como falar
        </h2>
        <div className="sb-forn-grade">{CONTATO.map(renderCampo)}</div>
      </section>

      <section className="sb-form-secao" aria-labelledby="forn-secao-notas">
        <h2 id="forn-secao-notas" className="sb-form-secao-titulo">
          Observações
        </h2>
        <label className="sb-form-campo" htmlFor="forn-notes">
          <span className="sb-sr-only">Observações</span>
          <textarea
            id="forn-notes"
            className="sb-input sb-input-full"
            name="notes"
            rows={3}
            defaultValue={inicial?.notes ?? ""}
            placeholder="prazo de entrega combinado, pedido mínimo, condição de pagamento…"
          />
        </label>
      </section>

      {mensagem !== null && (
        <p role="alert" className="sb-note sb-note-perigo" style={{ margin: 0 }}>
          {mensagem}
        </p>
      )}

      <div className="sb-forn-form-acoes">
        <Link className="sb-button" href={destinoCancelar}>
          Cancelar
        </Link>
        <button className="sb-button sb-button-primary" type="submit" disabled={salvando}>
          {salvando ? "Salvando…" : id === null ? "Cadastrar fornecedor" : "Salvar alterações"}
        </button>
      </div>
    </form>
  );
}
