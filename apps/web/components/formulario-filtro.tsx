"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useTransition, type ComponentProps, type ReactNode, type SubmitEvent } from "react";

import { destinoDoFormulario } from "../lib/destino-do-formulario";
import { AtualizandoTela } from "./carregando-link";

/**
 * O formulário GET de busca e filtro das telas — com navegação suave e a
 * atualização no lugar (D-500).
 *
 * Era `<form method="get">` nativo: cada "Buscar" recarregava o DOCUMENTO
 * inteiro, com a tela em branco no meio e sem sinal nenhum até a página nova
 * chegar. Medido em `/estoque` com 600 ms de latência: 1.296 ms por busca.
 *
 * O que ele faz no envio é o que o navegador faria — os mesmos campos, na mesma
 * ordem, para o mesmo `action`, com a `?busca` inteira substituída — mas por
 * `router.push` dentro de uma transição. O pendente da transição é o da própria
 * navegação: a `AtualizandoTela` entra no envio e sai quando a tela nova chega.
 * Antes do JavaScript carregar, o `<form>` continua sendo um GET nativo.
 *
 * **Por que não o `<Form>` de `next/form`:** no App Router ele chama
 * `router.push` sem transição, e o `useFormStatus` que a documentação sugere
 * nunca fica pendente (conferido no código do Next 16.3, `app-dir/form.js`).
 *
 * **O formulário renasce a cada `?busca` nova.** A recarga entregava sempre um
 * formulário novo, com os valores da URL; na navegação suave o campo que a
 * pessoa digitou fica "sujo" e o `defaultValue` novo não o alcança — "Limpar
 * filtros" limparia a URL e deixaria o texto velho no campo. A `key` pela
 * `?busca` remonta o formulário com o que o servidor mandou, e o foco volta para
 * o campo em que a pessoa estava.
 */
export function FormularioFiltro({
  action,
  children,
  ...resto
}: { action: string; children: ReactNode } & Omit<ComponentProps<"form">, "action" | "method" | "onSubmit">): ReactNode {
  const router = useRouter();
  const busca = useSearchParams();
  const [pendente, iniciar] = useTransition();
  const ultimoDestino = useRef<string | null>(null);
  const campoEmFoco = useRef<string | null>(null);
  const formularioMontado = useRef<HTMLFormElement | null>(null);

  // A busca que não mudou a URL não remonta o formulário: o pedido de foco não
  // pode sobrar para a próxima remontagem, que pode vir de uma pílula.
  useEffect(() => {
    if (!pendente) campoEmFoco.current = null;
  }, [pendente]);

  function enviar(evento: SubmitEvent<HTMLFormElement>): void {
    const formulario = evento.currentTarget;
    const quemEnviou = evento.nativeEvent.submitter;

    // Envio que o navegador precisa fazer sozinho: outro destino ou outro método.
    if (
      formulario.target !== "" ||
      (quemEnviou !== null && (quemEnviou.hasAttribute("formaction") || quemEnviou.hasAttribute("formmethod")))
    ) {
      return;
    }

    evento.preventDefault();

    const href = destinoDoFormulario(formulario.action, new FormData(formulario, quemEnviou));

    // Enter repetido no campo enquanto a mesma busca pende não lê de novo.
    if (pendente && href === ultimoDestino.current) return;

    ultimoDestino.current = href;

    // Formulário dentro de um menu (o período personalizado do `FilterMenu`):
    // a recarga fechava o `<details>`; na navegação suave ele fecharia só se
    // alguém o fechasse — como a opção do menu faz (`ItemDeMenu`).
    formulario.closest("details")?.removeAttribute("open");

    const emFoco = document.activeElement;

    campoEmFoco.current =
      emFoco instanceof HTMLInputElement && formulario.contains(emFoco) && emFoco.name !== "" ? emFoco.name : null;

    iniciar(() => {
      router.push(href);
    });
  }

  return (
    <form
      key={busca.toString()}
      {...resto}
      action={action}
      method="get"
      onSubmit={enviar}
      ref={(formulario) => {
        // Só o formulário RENASCIDO devolve o foco: a mesma instância passa por
        // aqui a cada render (o pendente re-renderiza), e devolver ali gastaria
        // o pedido antes da tela nova.
        if (formulario === null || formulario === formularioMontado.current) return;

        formularioMontado.current = formulario;

        const nome = campoEmFoco.current;

        if (nome === null) return;

        campoEmFoco.current = null;

        const campo = formulario.elements.namedItem(nome);

        if (campo instanceof HTMLInputElement) {
          campo.focus();

          // O cursor no fim do texto, como estava; `email` e `number` não têm seleção.
          if (["text", "search", "tel", "url"].includes(campo.type)) {
            campo.setSelectionRange(campo.value.length, campo.value.length);
          }
        }
      }}
    >
      {children}
      {pendente && <AtualizandoTela />}
    </form>
  );
}
