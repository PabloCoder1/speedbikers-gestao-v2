"use client";

import { useState, type ReactNode } from "react";

import { DetailRow, Drawer } from "../../components/drawer";
import { TOM } from "../../components/tone";
import { iniciais } from "../../lib/initials";
import { memberStatusLabel, type MemberStatus } from "../../lib/member-filters";
import { tomDePapel } from "../../lib/role-tone";
import { AccountAccessControls, RoleSelect, type AccountOption } from "./member-controls";
import { ReemitirLink } from "./reemitir-link";

/**
 * A gaveta "Detalhe do Usuário" do frame (D39 — a quarta das cinco; refeita
 * contra o desenho em D-297).
 *
 * **É a única das cinco que não tem tela cheia atrás dela**, e por isso a
 * única em que a gaveta é o destino, não o resumo: `/usuarios` é lista, e
 * nunca houve página de pessoa. Ela também não tem rodapé — não existe "abrir
 * página completa" para apontar, e um botão que não leva a lugar nenhum seria
 * pior que nenhum.
 *
 * ## Ela virou o lugar de EDITAR, e isso é fidelidade, não conveniência
 *
 * Até D-297 o papel era um `<select>` e o alcance eram quatro caixas **dentro
 * da tabela**, uma vez por linha. Na tela inteira isso é o que o usuário viu e
 * chamou de inferior ao desenho: o frame põe SELO em Papel e TEXTO em contas, e
 * a tabela dele se lê de uma passada. Os controles não desapareceram — eles
 * moram aqui, no cartão "Papel e Permissões" que o frame desenha, que é onde
 * uma pessoa é olhada uma por vez.
 *
 * A autorização não mudou de lugar nenhum: continua nas policies
 * `*_admin_writes` e no trigger `guard_last_admin`. Se esta gaveta sumisse,
 * ninguém ganharia nem perderia poder.
 *
 * ## Não faz uma ida sequer
 *
 * Tudo o que ela mostra a página JÁ CARREGOU para desenhar a tabela: membros,
 * contas, permissões, a janela de `auth.users` (D-296) e as 50 mudanças de
 * acesso. Os eventos chegam aqui **já traduzidos** pelo servidor — o
 * vocabulário de `eventoLabel` mora lá, e duplicá-lo no cliente criaria duas
 * versões da mesma frase.
 *
 * ## O que o frame mostra e continua sem existir
 *
 * A frase que descreve o que cada papel pode fazer ("pode gerenciar usuários,
 * visualizar faturamento global…"). A autorização real são as policies e o
 * `check` da tabela, não uma prosa; escrevê-la aqui seria arriscar DESCREVER
 * ERRADO o que o banco permite, que é pior que não descrever.
 *
 * E a "Proteção Ativa" do frame é a mais real de todas: `guard_last_admin` é um
 * trigger, e ele recusa a mudança venha ela desta gaveta, da Server Action ou
 * do SQL.
 */
export interface EventoDeAcesso {
  id: string;
  quando: string;
  oQue: string;
  quemMudou: string;
  conta: string | null;
}

export function DetalheUsuario({
  nome,
  email,
  userId,
  organizationId,
  role,
  roleLabel,
  status,
  contas,
  todasPorAdmin,
  desde,
  ultimoAcesso,
  ehUltimoAdmin,
  editavel,
  accounts,
  granted,
  historico,
  historicoVisivel,
}: {
  nome: string | null;
  /** Só existe para ADMIN: é a janela de D-296 que o traz. */
  email: string | null;
  userId: string;
  organizationId: string;
  role: string;
  roleLabel: string;
  status: MemberStatus;
  /** Rótulos das contas alcançadas, já resolvidos pelo servidor. */
  contas: readonly string[];
  /** ADMIN alcança todas por papel, sem linha em `user_account_permissions`. */
  todasPorAdmin: boolean;
  desde: string;
  ultimoAcesso: string;
  /** ADMIN e único ADMIN da organização — o caso que o trigger protege. */
  ehUltimoAdmin: boolean;
  /** Quem vê os controles. Esconder é cortesia; a policy recusa igual. */
  editavel: boolean;
  accounts: AccountOption[];
  granted: string[];
  historico: EventoDeAcesso[];
  /** O histórico só existe para ADMIN: a policy não devolve linha aos demais. */
  historicoVisivel: boolean;
}): ReactNode {
  const [aberta, setAberta] = useState(false);

  const rotulo = nome ?? email ?? userId;
  // A MESMA regra do avatar do topo e do autor de decisão (D-320) — era
  // `charAt(0)`, uma letra, e a mesma pessoa tinha dois monogramas no app.
  const monograma = iniciais(rotulo);

  return (
    <>
      {/*
        O GATILHO É O NOME, como no frame — onde a linha toda é clicável.

        Nasceu "Inspecionar" numa coluna própria, e a coluna saiu em D-297: o
        frame tem cinco colunas, e uma sexta só para o verbo era a tabela
        anunciando o mecanismo em vez do dado. O nome acessível da célula
        continua sendo o nome da pessoa (é o texto do botão), que é o que
        `usuarios.spec.ts` afirma desde D-234.
      */}
      <button
        type="button"
        className="sb-entity-button"
        onClick={() => {
          setAberta(true);
        }}
      >
        {nome ?? <span style={{ color: "var(--sb-text-soft)" }}>sem nome no perfil</span>}
      </button>

      {aberta && (
        <Drawer
          eyebrow="Detalhe do usuário"
          label={`Detalhe do usuário ${rotulo}`}
          onClose={() => {
            setAberta(false);
          }}
        >
          <div style={{ display: "flex", gap: "var(--sb-space-3)", alignItems: "flex-start" }}>
            <span className="sb-avatar sb-avatar-grande" aria-hidden="true">
              {monograma}
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--sb-space-2)" }}>
                <span className="sb-object-id">Identidade</span>
                {/*
                  O selo que o frame põe aqui, agora com fonte (D-296): "Ativo"
                  é quem já entrou alguma vez; "Convite pendente", quem tem
                  vínculo e nunca entrou.
                */}
                <span className="sb-status" style={status === "ativo" ? TOM.ok : TOM.neutro}>
                  {memberStatusLabel(status)}
                </span>
              </div>
              <h3 style={{ margin: "0.25rem 0 0.25rem", fontSize: "1rem", color: "var(--sb-primary)" }}>
                {nome ?? "sem nome no perfil"}
              </h3>
              {/* O e-mail sob o nome, como o frame. Sem janela (não-ADMIN), a
                  linha não aparece — traço ali prometeria um dado escondido. */}
              {email !== null && (
                <span style={{ fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>{email}</span>
              )}
            </div>
          </div>

          <div className="sb-drawer-card">
            <h4>Papel e permissões</h4>

            {/*
              UM DONO POR DADO, também aqui: quem edita vê o CONTROLE, quem lê vê
              o SELO. Os dois juntos diziam a mesma coisa duas vezes na mesma
              linha — o selo "GESTOR" em cima do menu já em GESTOR —, e foi assim
              que a captura mostrou. Quem edita continua vendo o selo do papel na
              tabela, a dois centímetros dali.
            */}
            <div className="sb-drawer-card-parte">
              <span>Papel na organização</span>

              {editavel ? (
                <RoleSelect organizationId={organizationId} userId={userId} role={role} />
              ) : (
                <span className="sb-status" style={TOM[tomDePapel(role)]}>
                  {roleLabel}
                </span>
              )}
            </div>

            <div className="sb-drawer-card-parte">
              <span>Contas Mercado Livre permitidas</span>

              {todasPorAdmin ? (
                /* ADMIN alcança tudo por `private.has_account_access`, sem linha
                   em `user_account_permissions`: não há controle a oferecer, e
                   oferecê-lo sugeriria que ele muda alguma coisa. */
                <span className="sb-status" style={TOM.info}>
                  todas as contas (por ser ADMIN)
                </span>
              ) : editavel ? (
                <AccountAccessControls userId={userId} role={role} accounts={accounts} granted={granted} />
              ) : contas.length === 0 ? (
                <span style={{ fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>nenhuma conta associada</span>
              ) : (
                <div className="sb-badge-row">
                  {contas.map((conta) => (
                    <span className="sb-status" key={conta} style={TOM.info}>
                      {conta}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {ehUltimoAdmin && (
            /*
              Tom de ATENÇÃO, e o frame usa perigo. A diferença é semântica, não
              estética: nesta casa `perigo` é coisa errada acontecendo, e aqui
              nada está errado — uma proteção está de pé. Pintar de vermelho
              faria o operador procurar um defeito que não existe.
            */
            <p className="sb-note sb-note-atencao" style={{ marginTop: "var(--sb-space-3)" }}>
              <span>Proteção ativa</span>
              <span
                style={{
                  display: "block",
                  fontFamily: "var(--sb-sans)",
                  fontSize: "0.6875rem",
                  marginTop: "0.375rem",
                }}
              >
                Este é o único ADMIN da organização. O banco recusa rebaixar ou remover este vínculo
                até que outro administrador exista — a recusa é do trigger, não desta tela.
              </span>
            </p>
          )}

          <div style={{ marginTop: "var(--sb-space-3)" }}>
            <DetailRow
              label="Último acesso"
              value={ultimoAcesso}
              note={email === null ? "só um ADMIN enxerga o histórico de login" : undefined}
            />
            <DetailRow label="Membro desde" value={desde} />
            <DetailRow label="Identificador" value={<span className="sb-mono">{userId}</span>} />
          </div>

          {/*
            A SAÍDA PARA QUEM NÃO CONSEGUE ENTRAR (D-303). Só para quem edita, e
            só depois de confirmar: o link vale como senha da conta de destino.
          */}
          {editavel && <ReemitirLink userId={userId} nome={nome ?? email ?? "esta pessoa"} />}

          <h4 className="sb-section-label" style={{ marginTop: "var(--sb-space-3)" }}>
            Mudanças de acesso desta pessoa
          </h4>

          {!historicoVisivel ? (
            <p className="sb-empty">Só um ADMIN enxerga o histórico de acesso.</p>
          ) : historico.length === 0 ? (
            <p className="sb-empty">
              Nenhuma mudança registrada para esta pessoa nas 50 mais recentes da organização.
            </p>
          ) : (
            historico.map((evento) => (
              <DetailRow
                key={evento.id}
                label={evento.quando}
                value={evento.oQue}
                note={`por ${evento.quemMudou}${evento.conta === null ? "" : ` · ${evento.conta}`}`}
              />
            ))
          )}
        </Drawer>
      )}
    </>
  );
}
