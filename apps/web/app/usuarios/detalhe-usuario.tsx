"use client";

import { useState, type ReactNode } from "react";

import { DetailRow, Drawer } from "../../components/drawer";
import { TOM } from "../../components/tone";

/**
 * A gaveta "Detalhe do Usuário" do frame (D39 — a quarta das cinco).
 *
 * **É a única das cinco que não tem tela cheia atrás dela**, e por isso a
 * única em que a gaveta é o destino, não o resumo: `/usuarios` é lista, e
 * nunca houve página de pessoa. Ela também não tem rodapé — não existe "abrir
 * página completa" para apontar, e um botão que não leva a lugar nenhum seria
 * pior que nenhum.
 *
 * ## Não faz uma ida sequer
 *
 * Tudo o que ela mostra a página JÁ CARREGOU para desenhar a tabela: membros,
 * contas, permissões e as 50 mudanças de acesso. Os eventos chegam aqui **já
 * traduzidos** pelo servidor — o vocabulário de `eventoLabel` mora lá, e
 * duplicá-lo no cliente criaria duas versões da mesma frase.
 *
 * ## O que o frame mostra e não existe
 *
 * - **e-mail sob o nome**: vive em `auth.users`, que o PostgREST não expõe;
 *   buscá-lo exigiria uma `security definer` só para exibir contato (D-271);
 * - **"Ativo"**: não há tabela de convite, então todo membro é ativo por
 *   construção — um selo de valor único não informa nada;
 * - **a descrição do que o papel pode fazer**: a autorização real são as
 *   policies e o `check` da tabela, não uma frase; escrever prose aqui seria
 *   arriscar DESCREVER ERRADO o que o banco permite, que é pior que não
 *   descrever.
 *
 * O que ficou é o que tem fonte — e a "Proteção Ativa" do frame é a mais real
 * de todas: `guard_last_admin` é um trigger, e ele recusa a mudança venha ela
 * desta tela, da Server Action ou do SQL.
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
  userId,
  role,
  roleLabel,
  contas,
  desde,
  ehUltimoAdmin,
  historico,
  historicoVisivel,
}: {
  nome: string | null;
  userId: string;
  role: string;
  roleLabel: string;
  /** Já resolvido pelo servidor: rótulos de conta, ou a regra do ADMIN. */
  contas: string;
  desde: string;
  /** ADMIN e único ADMIN da organização — o caso que o trigger protege. */
  ehUltimoAdmin: boolean;
  historico: EventoDeAcesso[];
  /** O histórico só existe para ADMIN: a policy não devolve linha aos demais. */
  historicoVisivel: boolean;
}): ReactNode {
  const [aberta, setAberta] = useState(false);

  const monograma = (nome ?? "?").trim().charAt(0).toUpperCase();

  return (
    <>
      <button
        type="button"
        className="sb-text-button"
        onClick={() => {
          setAberta(true);
        }}
      >
        Inspecionar
      </button>

      {aberta && (
        <Drawer
          eyebrow="Detalhe do usuário"
          label={`Detalhe do usuário ${nome ?? userId}`}
          onClose={() => {
            setAberta(false);
          }}
        >
          <div style={{ display: "flex", gap: "var(--sb-space-3)", alignItems: "center" }}>
            <span className="sb-avatar" aria-hidden="true">
              {monograma}
            </span>
            <div style={{ minWidth: 0 }}>
              <span className="sb-object-id">Identidade</span>
              <h3 style={{ margin: "0.25rem 0 0.375rem", fontSize: "0.875rem", color: "var(--sb-primary)" }}>
                {nome ?? "sem nome no perfil"}
              </h3>
              <span className="sb-status" style={role === "ADMIN" ? TOM.atencao : TOM.info}>
                {roleLabel}
              </span>
            </div>
          </div>

          <div style={{ marginTop: "var(--sb-space-3)" }}>
            <DetailRow label="Papel" value={roleLabel} note={role} />
            <DetailRow
              label="Contas com acesso"
              value={contas}
              note="o papel decide o que a pessoa pode fazer; as contas, sobre o que ela faz"
            />
            <DetailRow label="Membro desde" value={desde} />
            <DetailRow
              label="Identificador"
              value={<span className="sb-mono">{userId}</span>}
              note="não há e-mail aqui: ele vive em auth.users, fora do alcance da web"
            />
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
