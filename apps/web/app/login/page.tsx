import { Suspense, type ReactNode } from "react";

import { LoginForm } from "./login-form";

export const metadata = { title: "Entrar — Speed Bikers Gestão" };

/*
  DINÂMICA DE PROPÓSITO (D-331). O login era a ÚNICA página pré-renderizada
  no build — as outras 50 rotas já eram dinâmicas. Com a CSP de nonce, uma
  página estática sai com os scripts SEM o nonce (não há requisição no build
  para gerá-lo), e `strict-dynamic` os bloqueia: o formulário renderizaria e
  não responderia a clique nenhum. A porta de entrada do sistema trancada.
*/
export const dynamic = "force-dynamic";

/**
 * A porta de entrada — a única tela fora do Shell.
 *
 * O Figma não desenha login, então a identidade vem do próprio app: o painel da
 * marca é o navy da sidebar com o símbolo amarelo e o "GESTÃO V3" em DM Mono, e
 * o formulário é um cartão branco sobre o chão cinza, como os painéis. Quem
 * entra reconhece a casa antes de entrar nela.
 *
 * **Nada no painel é número.** Os módulos listados são telas que existem; um
 * "12.000 pedidos processados" seria enfeite com cara de dado, e este projeto
 * recusa isso nas telas de dentro.
 */
export default function LoginPage(): ReactNode {
  return (
    <main className="sb-login">
      <section className="sb-login-marca" aria-label="Speed Bikers Gestão">
        <div className="sb-login-marca-topo">
          <span aria-hidden="true" className="sb-brand-symbol sb-login-simbolo">
            SB
          </span>
          <span>
            <b>Speed Bikers</b>
            <small>GESTÃO V3</small>
          </span>
        </div>

        <div className="sb-login-manchete-bloco">
          <span className="sb-eyebrow">SISTEMA INTERNO</span>
          <p className="sb-login-manchete">Vendas, estoque, compras e atendimento do Mercado Livre num só painel.</p>
          <ul className="sb-login-modulos">
            <li>Vendas e margem</li>
            <li>Estoque e Full</li>
            <li>Cobertura e reposição</li>
            <li>NF-e e compras</li>
            <li>Atendimento</li>
            <li>Copiloto</li>
          </ul>
        </div>

        <small className="sb-login-rodape">Acesso concedido pelo administrador · sem autocadastro</small>
      </section>

      <section className="sb-login-painel">
        <div className="sb-login-cartao">
          {/*
            `useSearchParams` le algo que so existe na requisicao. Sem o limite de
            Suspense, o Next tenta pre-renderizar a pagina no build e falha.
          */}
          <Suspense fallback={null}>
            <LoginForm />
          </Suspense>
        </div>
      </section>
    </main>
  );
}
