"use client";

import { useActionState, useState, type ReactNode } from "react";

import type { ConfiguracaoDoAlerta } from "../../../../lib/alerta-margem";
import { MAX_DESTINATARIOS, metaComoTexto } from "../../../../lib/alerta-margem";
import type { ResultadoDoCadastro } from "../metas/actions";
import { Campo, Mensagem } from "../metas/formularios";
import { salvarAlertaDeMargem } from "./actions";

const INICIAL: ResultadoDoCadastro = { ok: false, mensagem: null, erros: {} };

/**
 * O formulário do alerta de venda abaixo da margem (D-858). Os nomes dos campos
 * são as colunas de `margin_alert_settings`: a ação lê os cinco de uma vez.
 *
 * Campos CONTROLADOS: o React limpa o formulário não controlado depois de cada
 * envio, e a lista de e-mails sumiria justo quando um deles volta com erro.
 */
export function FormularioAlertaDeMargem({ atual }: { atual: ConfiguracaoDoAlerta }): ReactNode {
  const [resultado, enviar, salvando] = useActionState(salvarAlertaDeMargem, INICIAL);
  const [ligado, setLigado] = useState(atual.enabled);
  const [importada, setImportada] = useState(metaComoTexto(atual.imported_min_margin));
  const [demais, setDemais] = useState(metaComoTexto(atual.default_min_margin));
  const [marcas, setMarcas] = useState(atual.imported_brands.join("\n"));
  const [emails, setEmails] = useState(atual.email_recipients.join("\n"));

  return (
    <form action={enviar} className="sb-limites-form" aria-label="Alerta de venda abaixo da margem">
      <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <input
          type="checkbox"
          name="enabled"
          checked={ligado}
          onChange={(e) => {
            setLigado(e.target.checked);
          }}
        />
        <span>Avisar quando uma venda sair abaixo da margem mínima</span>
      </label>

      <div className="sb-cadastro-form">
        <Campo nome="imported_min_margin" rotulo="Margem mínima das importadas (%)" dica="Padrão: 40" erro={resultado.erros.imported_min_margin}>
          {(props) => (
            <input
              {...props}
              className="sb-input"
              name="imported_min_margin"
              inputMode="decimal"
              value={importada}
              onChange={(e) => {
                setImportada(e.target.value);
              }}
              required
            />
          )}
        </Campo>
        <Campo nome="default_min_margin" rotulo="Margem mínima dos demais (%)" dica="Padrão: 30" erro={resultado.erros.default_min_margin}>
          {(props) => (
            <input
              {...props}
              className="sb-input"
              name="default_min_margin"
              inputMode="decimal"
              value={demais}
              onChange={(e) => {
                setDemais(e.target.value);
              }}
              required
            />
          )}
        </Campo>
      </div>

      <Campo
        nome="imported_brands"
        rotulo="Marcas importadas"
        dica="Uma por linha. Vale a marca do fornecedor do produto; maiúsculas e espaços não importam."
        erro={resultado.erros.imported_brands}
        ajuda={{
          pergunta: "E o produto sem marca?",
          texto: (
            <p>
              O produto sem marca do fornecedor atribuída é julgado pela margem dos demais. O kit é julgado como importado quando
              algum componente for de marca importada.
            </p>
          ),
        }}
      >
        {(props) => (
          <textarea
            {...props}
            className="sb-input"
            name="imported_brands"
            rows={3}
            value={marcas}
            onChange={(e) => {
              setMarcas(e.target.value);
            }}
          />
        )}
      </Campo>

      <Campo
        nome="email_recipients"
        rotulo="E-mails que recebem o aviso"
        dica={`Um por linha, até ${String(MAX_DESTINATARIOS)}. Sem nenhum, o aviso cai só no sino do sistema.`}
        erro={resultado.erros.email_recipients}
      >
        {(props) => (
          <textarea
            {...props}
            className="sb-input"
            name="email_recipients"
            rows={5}
            value={emails}
            onChange={(e) => {
              setEmails(e.target.value);
            }}
            spellCheck={false}
          />
        )}
      </Campo>

      <div className="sb-cadastro-acoes">
        <button type="submit" className="sb-button sb-button-primary" disabled={salvando}>
          {salvando ? "Salvando…" : "Salvar alerta"}
        </button>
        <Mensagem resultado={resultado} />
      </div>
    </form>
  );
}
