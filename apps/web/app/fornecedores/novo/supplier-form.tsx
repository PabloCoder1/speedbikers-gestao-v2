"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";

import { Icone, type NomeDoIcone } from "../../../components/icons";
import { LOGO_TIPOS_ACEITOS, enviarLogo, prepararLogo, removerLogo } from "../../../lib/logo-fornecedor";
import type { CampoFornecedor } from "../../../lib/supplier-form";
import {
  CONDICOES,
  acharDuplicados,
  acrescentarCondicao,
  completude,
  estadoDocumento,
  formatarTelefone,
  type FornecedorExistente,
  type ValoresGuia,
} from "../../../lib/supplier-form-guia";
import { formatarDocumento } from "../../../lib/suppliers-overview";
import { salvarFornecedor } from "../actions";
import { Canais } from "../canais";
import { LogoFornecedor } from "../logo";

/**
 * O formulário de fornecedor — cadastro e edição (D-366, refeito em D-367).
 *
 * D-366 separou os campos em grupos e pôs cada erro no próprio campo. D-367
 * acrescenta o que a tela diz ENQUANTO se digita, sem mudar o que se grava:
 *
 *   - prévia ao vivo de como o fornecedor aparece na lista e no pedido, com os
 *     canais já como botões;
 *   - selo do CNPJ/CPF (válido, faltam N dígitos, não confere);
 *   - aviso de fornecedor que já existe com o mesmo nome ou documento, com o
 *     link para ele — o banco só recusa o nome IDÊNTICO;
 *   - quanto do cadastro está preenchido, item a item;
 *   - telefone formatado ao sair do campo, "usar o telefone" no WhatsApp e
 *     atalhos de condição comercial nas observações.
 *
 * Os campos continuam NÃO controlados: a prévia lê o formulário a cada
 * `input`. Assim o que foi digitado sobrevive a um erro do servidor (o motivo
 * do `onSubmit` abaixo) e a conferência continua sendo `conferirCadastro`.
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

type NomeCampo = Exclude<CampoFornecedor, "notes">;

interface Campo {
  nome: NomeCampo;
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
    dica: "como a equipe chama o fornecedor — é o que aparece na lista e no pedido",
    autoComplete: "organization",
    placeholder: "ex.: Navetec",
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
    largo: true,
  },
  {
    nome: "whatsapp",
    rotulo: "WhatsApp",
    tipo: "tel",
    placeholder: "(11) 98765-4321",
  },
  {
    nome: "phone",
    rotulo: "Telefone",
    tipo: "tel",
    autoComplete: "tel",
    placeholder: "(11) 3333-4444",
  },
  {
    nome: "email",
    rotulo: "E-mail",
    tipo: "email",
    autoComplete: "email",
    placeholder: "vendas@fornecedor.com.br",
  },
  {
    nome: "website",
    rotulo: "Site",
    tipo: "url",
    autoComplete: "url",
    placeholder: "fornecedor.com.br",
  },
];

const nulo = (v: string): string | null => (v.trim() === "" ? null : v.trim());

function valoresIniciais(inicial: ValoresFornecedor | null): ValoresGuia {
  return {
    name: inicial?.name ?? "",
    legalName: inicial?.legalName ?? "",
    document: formatarDocumento(inicial?.document ?? null) ?? "",
    contactName: inicial?.contactName ?? "",
    email: inicial?.email ?? "",
    phone: inicial?.phone ?? "",
    whatsapp: inicial?.whatsapp ?? "",
    website: inicial?.website ?? "",
    notes: inicial?.notes ?? "",
  };
}

function lerFormulario(form: HTMLFormElement): ValoresGuia {
  const dados = new FormData(form);
  const ler = (nome: keyof ValoresGuia): string => {
    const valor = dados.get(nome);

    return typeof valor === "string" ? valor : "";
  };

  return {
    name: ler("name"),
    legalName: ler("legalName"),
    document: ler("document"),
    contactName: ler("contactName"),
    email: ler("email"),
    phone: ler("phone"),
    whatsapp: ler("whatsapp"),
    website: ler("website"),
    notes: ler("notes"),
  };
}

function Secao({
  numero,
  icone,
  titulo,
  descricao,
  id,
  children,
}: {
  numero: number;
  icone: NomeDoIcone;
  titulo: string;
  descricao: string;
  id: string;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="sb-form-secao sb-fnv-secao" aria-labelledby={id}>
      <header className="sb-fnv-secao-cabeca">
        <span className="sb-fnv-secao-icone" aria-hidden="true">
          <Icone nome={icone} tamanho={16} />
        </span>
        <div>
          <h2 id={id}>
            <span className="sb-fnv-secao-numero">{numero}</span> {titulo}
          </h2>
          <p>{descricao}</p>
        </div>
      </header>
      {children}
    </section>
  );
}

export function SupplierForm({
  id = null,
  inicial = null,
  existentes = [],
  organizationId,
  logoPath = null,
}: {
  /** Nulo = cadastro novo. */
  id?: string | null;
  inicial?: ValoresFornecedor | null;
  /** Os fornecedores da organização, para o aviso de duplicado (D-367). */
  existentes?: readonly FornecedorExistente[];
  /** A pasta da logo no bucket (D-370). Nulo: a conta não tem organização, e a logo não é oferecida. */
  organizationId: string | null;
  /** O caminho da logo já salva, na edição. */
  logoPath?: string | null;
}): ReactNode {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [salvando, startTransition] = useTransition();
  const [erros, setErros] = useState<Partial<Record<CampoFornecedor, string>>>({});
  const [mensagem, setMensagem] = useState<string | null>(null);
  const [valores, setValores] = useState<ValoresGuia>(() => valoresIniciais(inicial));
  // A logo só sobe DEPOIS de o cadastro ser salvo: o fornecedor novo ainda não
  // tem id para a RPC apontar. Até lá ela fica aqui, preparada (D-370).
  const [logoNova, setLogoNova] = useState<Blob | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [tirarLogo, setTirarLogo] = useState(false);
  const [preparandoLogo, setPreparandoLogo] = useState(false);
  const [erroLogo, setErroLogo] = useState<string | null>(null);

  // O `URL.createObjectURL` segura o blob na memória até ser revogado.
  useEffect(() => {
    return () => {
      if (logoPreview !== null) URL.revokeObjectURL(logoPreview);
    };
  }, [logoPreview]);

  const temLogo = logoPreview !== null || (logoPath !== null && !tirarLogo);

  const destinoCancelar = id === null ? "/fornecedores" : `/fornecedores/${id}`;
  const documento = estadoDocumento(valores.document);
  const duplicados = acharDuplicados(existentes, valores, id);
  const cadastro = completude(valores);

  function atualizarPrevia(): void {
    if (formRef.current !== null) setValores(lerFormulario(formRef.current));
  }

  /** Mudança feita pela tela (formatar, copiar, atalho): escreve no campo e atualiza a prévia. */
  function definir(nome: keyof ValoresGuia, valor: string, focar = false): void {
    const campo = formRef.current?.elements.namedItem(nome);

    if (campo instanceof HTMLInputElement || campo instanceof HTMLTextAreaElement) {
      campo.value = valor;

      if (focar) {
        campo.focus();
        campo.setSelectionRange(valor.length, valor.length);
      }
    }

    atualizarPrevia();
  }

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

      const salvo = resultado.id;

      // A logo vai depois do cadastro. Se ela falhar, o fornecedor JÁ existe:
      // voltar a este formulário e salvar de novo criaria outro. A pessoa vai
      // para a edição dele, que diz o que faltou (D-370).
      if (salvo !== undefined && organizationId !== null && (logoNova !== null || (tirarLogo && logoPath !== null))) {
        try {
          if (logoNova !== null) await enviarLogo(organizationId, salvo, logoNova);
          else await removerLogo(salvo);
        } catch {
          router.push(`/fornecedores/${salvo}/editar?aviso=logo`);
          router.refresh();

          return;
        }
      }

      router.push(salvo === undefined ? "/fornecedores" : `/fornecedores/${salvo}`);
      router.refresh();
    });
  }

  async function escolherLogo(arquivo: File): Promise<void> {
    setErroLogo(null);
    setPreparandoLogo(true);

    try {
      const logo = await prepararLogo(arquivo);

      setLogoNova(logo);
      setLogoPreview(URL.createObjectURL(logo));
      setTirarLogo(false);
    } catch (falha) {
      setErroLogo(falha instanceof Error ? falha.message : "Não foi possível usar esta imagem.");
    } finally {
      setPreparandoLogo(false);
    }
  }

  function tirarALogo(): void {
    setErroLogo(null);
    setLogoNova(null);
    setLogoPreview(null);
    setTirarLogo(logoPath !== null);
  }

  function aoSair(campo: NomeCampo, elemento: HTMLInputElement): void {
    const valor = elemento.value.trim();

    if (campo === "document") {
      const formatado = formatarDocumento(valor === "" ? null : valor);

      if (formatado !== null) definir("document", formatado);
    }

    if ((campo === "phone" || campo === "whatsapp") && valor !== "") definir(campo, formatarTelefone(valor));
  }

  function extras(campo: NomeCampo): ReactNode {
    if (campo === "name" && duplicados.porNome !== null) {
      const outro = duplicados.porNome;

      return (
        <span className="sb-fnv-aviso" role="status">
          Já existe <b>{outro.name}</b>
          {!outro.isActive && " (inativo)"} ·{" "}
          <Link href={`/fornecedores/${outro.id}`} target="_blank">
            abrir
          </Link>
        </span>
      );
    }

    if (campo === "document") {
      return (
        <>
          {documento.tipo === "valido" && <span className="sb-fnv-selo sb-fnv-selo-ok">{documento.rotulo} válido</span>}
          {documento.tipo === "invalido" && <span className="sb-fnv-selo sb-fnv-selo-erro">{documento.texto}</span>}
          {documento.tipo === "digitando" && (
            <span className="sb-fnv-selo">
              {documento.faltam === 3 ? "faltam 3 para CNPJ" : `faltam ${String(documento.faltam)} dígitos`}
            </span>
          )}
          {duplicados.porDocumento !== null && (
            <span className="sb-fnv-aviso" role="status">
              Este documento já está em <b>{duplicados.porDocumento.name}</b> ·{" "}
              <Link href={`/fornecedores/${duplicados.porDocumento.id}`} target="_blank">
                abrir
              </Link>
            </span>
          )}
        </>
      );
    }

    if (campo === "whatsapp" && valores.whatsapp.trim() === "" && valores.phone.trim() !== "") {
      return (
        <button type="button" className="sb-text-button" onClick={() => {
            definir("whatsapp", valores.phone);
          }}>
          usar o número do telefone
        </button>
      );
    }

    return null;
  }

  function renderCampo(campo: Campo): ReactNode {
    const erro = erros[campo.nome];
    const valorInicial = inicial?.[campo.nome] ?? "";

    return (
      <div key={campo.nome} className={campo.largo === true ? "sb-form-campo sb-forn-campo-largo" : "sb-form-campo"}>
        <label htmlFor={`forn-${campo.nome}`}>
          {campo.rotulo}
          {campo.nome === "name" && <span className="sb-forn-obrigatorio"> obrigatório</span>}
        </label>
        <input
          id={`forn-${campo.nome}`}
          className="sb-input sb-input-full"
          name={campo.nome}
          type={campo.tipo === "url" ? "text" : (campo.tipo ?? "text")}
          inputMode={campo.tipo === "url" ? "url" : campo.nome === "document" ? "numeric" : undefined}
          defaultValue={campo.nome === "document" ? (formatarDocumento(valorInicial || null) ?? "") : valorInicial}
          required={campo.nome === "name"}
          maxLength={campo.nome === "name" ? 200 : undefined}
          autoComplete={campo.autoComplete ?? "off"}
          placeholder={campo.placeholder}
          aria-invalid={erro === undefined ? undefined : true}
          aria-describedby={erro === undefined ? undefined : `forn-${campo.nome}-erro`}
          onBlur={(evento) => {
            aoSair(campo.nome, evento.currentTarget);
          }}
        />
        {erro === undefined ? (
          campo.dica !== undefined && <small>{campo.dica}</small>
        ) : (
          <span id={`forn-${campo.nome}-erro`} className="sb-campo-erro" role="alert">
            {erro}
          </span>
        )}
        {extras(campo.nome)}
      </div>
    );
  }

  const nomePrevia = valores.name.trim();
  const documentoPrevia = formatarDocumento(nulo(valores.document));
  const canais = {
    whatsapp: nulo(valores.whatsapp),
    phone: nulo(valores.phone),
    email: nulo(valores.email),
    website: nulo(valores.website),
  };
  const semCanal = Object.values(canais).every((v) => v === null);

  return (
    <form
      ref={formRef}
      className="sb-forn-form sb-fnv"
      noValidate
      onInput={atualizarPrevia}
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
      <div className="sb-fnv-layout">
        <div className="sb-fnv-secoes">
          <Secao
            numero={1}
            icone="loja"
            titulo="Quem é"
            descricao="O nome do dia a dia e os dados como estão na nota fiscal."
            id="forn-secao-quem"
          >
            {organizationId !== null && (
              <div className="sb-fnv-logo">
                <LogoFornecedor
                  nome={nomePrevia === "" ? "?" : nomePrevia}
                  logoPath={tirarLogo ? null : logoPath}
                  previewUrl={logoPreview}
                  className="sb-fnv-logo-imagem"
                />
                <div className="sb-fnv-logo-acoes">
                  <b>Logo</b>
                  <div className="sb-fnv-logo-botoes">
                    <label className={`sb-button sb-button-sm${preparandoLogo ? " sb-campo-foto-ocupado" : ""}`}>
                      <Icone nome="mais" tamanho={12} />
                      {preparandoLogo ? "Preparando…" : temLogo ? "Trocar logo" : "Adicionar logo"}
                      <input
                        className="sb-input sb-sr-only"
                        type="file"
                        accept={LOGO_TIPOS_ACEITOS}
                        disabled={preparandoLogo || salvando}
                        onChange={(evento) => {
                          const arquivo = evento.target.files?.[0];

                          // Zera o valor: escolher o MESMO arquivo de novo precisa disparar `change`.
                          evento.target.value = "";

                          if (arquivo !== undefined) void escolherLogo(arquivo);
                        }}
                      />
                    </label>
                    {temLogo && (
                      <button type="button" className="sb-text-button" disabled={salvando} onClick={tirarALogo}>
                        Remover
                      </button>
                    )}
                  </div>
                  <small>
                    {logoNova !== null
                      ? "Pronta — sobe quando você salvar."
                      : tirarLogo
                        ? "Será removida quando você salvar."
                        : "Opcional. JPG, PNG ou WebP — ajustada sem cortar, fundo transparente mantido."}
                  </small>
                  {erroLogo !== null && (
                    <span role="alert" className="sb-campo-erro">
                      {erroLogo}
                    </span>
                  )}
                </div>
              </div>
            )}
            <div className="sb-forn-grade">{IDENTIFICACAO.map(renderCampo)}</div>
          </Secao>

          <Secao
            numero={2}
            icone="mensagem"
            titulo="Como falar"
            descricao="Cada canal vira botão na lista e no painel: um toque abre o WhatsApp, o discador ou o e-mail."
            id="forn-secao-contato"
          >
            <div className="sb-forn-grade">{CONTATO.map(renderCampo)}</div>
          </Secao>

          <Secao
            numero={3}
            icone="recibo"
            titulo="Condições e observações"
            descricao="O que quem vai comprar precisa saber antes de montar o pedido."
            id="forn-secao-notas"
          >
            <div className="sb-fnv-atalhos" role="group" aria-label="Acrescentar condição comercial">
              {CONDICOES.map((condicao) => (
                <button
                  key={condicao}
                  type="button"
                  className="sb-button sb-button-sm"
                  onClick={() => {
                    definir("notes", acrescentarCondicao(valores.notes, condicao), true);
                  }}
                >
                  <Icone nome="mais" tamanho={12} />
                  {condicao}
                </button>
              ))}
            </div>
            <div className="sb-form-campo">
              <label htmlFor="forn-notes" className="sb-sr-only">
                Observações
              </label>
              <textarea
                id="forn-notes"
                className="sb-input sb-input-full"
                name="notes"
                rows={4}
                defaultValue={inicial?.notes ?? ""}
                placeholder="prazo de entrega combinado, pedido mínimo, condição de pagamento…"
              />
            </div>
          </Secao>
        </div>

        {/*
          A PRÉVIA: o cartão como a lista e o painel vão mostrar. Os canais são
          o mesmo componente da lista, então o que é link aqui é link lá.
        */}
        <aside className="sb-fnv-lateral" aria-label="Prévia do fornecedor">
          <div className="sb-fnv-previa">
            <span className="sb-fnv-rotulo">Prévia</span>
            <div className="sb-fnv-previa-cabeca">
              <LogoFornecedor
                nome={nomePrevia === "" ? "?" : nomePrevia}
                logoPath={tirarLogo ? null : logoPath}
                previewUrl={logoPreview}
                className="sb-forn-avatar sb-fnv-avatar"
              />
              <div>
                <b className={nomePrevia === "" ? "sb-fnv-vazio" : undefined}>{nomePrevia || "Nome do fornecedor"}</b>
                {valores.legalName.trim() !== "" && <small>{valores.legalName.trim()}</small>}
                {documentoPrevia !== null && (
                  <small className="sb-fnv-previa-doc">
                    {documentoPrevia}
                    {documento.tipo === "valido" && <span className="sb-fnv-selo sb-fnv-selo-ok">válido</span>}
                  </small>
                )}
              </div>
            </div>

            {valores.contactName.trim() !== "" && (
              <p className="sb-fnv-previa-contato">
                <Icone nome="pessoas" tamanho={14} /> {valores.contactName.trim()}
              </p>
            )}

            {semCanal ? (
              <p className="sb-fnv-previa-sem">Sem canal de contato ainda.</p>
            ) : (
              <Canais canais={canais} />
            )}
          </div>

          {/*
            AS AÇÕES moram na coluna que acompanha a rolagem. Eram uma barra
            grudada no pé da página, e ela cobria os campos ao rolar (visto na
            captura do dono, D-367). No celular a coluna vem depois do
            formulário, e os botões ficam no fim, sem sobrepor nada.
          */}
          <div className="sb-fnv-acoes">
            <span className="sb-fnv-acoes-resumo">
              {nomePrevia === "" ? "Preencha ao menos o nome para cadastrar." : `Cadastro ${String(cadastro.percentual)}% preenchido.`}
            </span>
            {mensagem !== null && (
              <p role="alert" className="sb-note sb-note-perigo" style={{ margin: 0 }}>
                {mensagem}
              </p>
            )}
            <button className="sb-button sb-button-primary" type="submit" disabled={salvando || preparandoLogo}>
              {salvando ? "Salvando…" : id === null ? "Cadastrar fornecedor" : "Salvar alterações"}
            </button>
            <Link className="sb-button" href={destinoCancelar}>
              Cancelar
            </Link>
          </div>

          <div className="sb-fnv-completude">
            <div className="sb-fnv-completude-topo">
              <span className="sb-fnv-rotulo">Cadastro</span>
              <b>{cadastro.percentual}%</b>
            </div>
            <span
              className="sb-fnv-barra"
              role="progressbar"
              aria-label="Cadastro preenchido"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={cadastro.percentual}
            >
              <i style={{ width: `${String(cadastro.percentual)}%` }} />
            </span>
            <ul>
              {cadastro.itens.map((item) => (
                <li key={item.chave} className={item.feito ? "sb-fnv-feito" : undefined}>
                  <span aria-hidden="true">{item.feito ? "✓" : ""}</span>
                  {item.rotulo}
                  <span className="sb-sr-only">{item.feito ? " — preenchido" : " — falta"}</span>
                </li>
              ))}
            </ul>
            <small>Só o nome é obrigatório. O resto poupa a procura por contato na hora de comprar.</small>
          </div>

          {id === null && (
            <p className="sb-fnv-depois">
              <Icone nome="carrinho" tamanho={14} />
              <span>
                Depois de cadastrar, você vai para o painel do fornecedor, de onde sai o primeiro pedido de compra.
              </span>
            </p>
          )}
        </aside>
      </div>

    </form>
  );
}
