"use client";

import { useState, type ReactNode } from "react";

import { Avatar } from "../../components/avatar";
import { CampoFoto } from "../../components/campo-foto";
import { DetailRow, Drawer } from "../../components/drawer";
import { EditarNome } from "../../components/editar-nome";
import { TOM } from "../../components/tone";
import { memberStatusLabel, memberStatusTone, type MemberStatus } from "../../lib/member-filters";
import { tomDePapel } from "../../lib/role-tone";
import { AcessoDoMembro } from "./acesso-membro";
import { AccountAccessControls, RoleSelect, type AccountOption } from "./member-controls";
import { ReemitirLink } from "./reemitir-link";

/**
 * A gaveta "Detalhe do Usuário" do frame (D39; refeita em D-297; nome, foto,
 * suspender e remover em D-354).
 *
 * **É a única das cinco gavetas que não tem tela cheia atrás dela**: `/usuarios`
 * é lista, e nunca houve página de pessoa. Por isso ela é o DESTINO — o lugar
 * de editar tudo o que é de uma pessoa.
 *
 * ## A ordem dos cartões é a ordem das perguntas
 *
 * 1. **quem é** — foto, nome (editável), e-mail e estado;
 * 2. **o que pode** — papel e contas (D-297);
 * 3. **desde quando** — último acesso, membro desde, identificador;
 * 4. **como entra** — link de acesso (D-303), suspender e remover (D-354);
 * 5. **o que mudou** — o histórico desta pessoa.
 *
 * O destrutivo fica embaixo de propósito: quem abre a gaveta para trocar um
 * papel não passa por "Remover" no caminho.
 *
 * A autorização não mora aqui: policies `*_admin_writes`,
 * `profiles_update_self_or_org_admin`, `guard_last_admin` e a `api` para a
 * suspensão. Se esta gaveta sumisse, ninguém ganharia nem perderia poder.
 *
 * **Não faz ida nenhuma para abrir**: tudo o que ela mostra a página já
 * carregou para desenhar a tabela.
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
  fotoPath,
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
  ehVoceMesmo,
  editavel,
  accounts,
  granted,
  historico,
  historicoVisivel,
}: {
  nome: string | null;
  /** Só existe para ADMIN: é a janela de D-296 que o traz. */
  email: string | null;
  fotoPath: string | null;
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
  /** A própria conta de quem olha: sem suspender nem remover. */
  ehVoceMesmo: boolean;
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

  return (
    <>
      {/*
        O GATILHO É O NOME, como no frame. O nome acessível da célula continua
        sendo o nome da pessoa (é o texto do botão), que é o que
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
          {/* 1. QUEM É */}
          <div className="sb-usuario-cabeca">
            {/*
              Quem edita troca a foto no próprio avatar grande; quem lê só a vê.
              Um cartão "Foto" separado repetiria o mesmo rosto duas vezes na
              mesma gaveta — a lição de "um dono por dado" de D-297.
            */}
            {editavel ? (
              <CampoFoto nome={rotulo} fotoAtual={fotoPath} modo={{ tipo: "imediato", userId }} />
            ) : (
              <Avatar nome={rotulo} fotoPath={fotoPath} tamanho="xl" />
            )}
          </div>

          <div className="sb-usuario-identidade">
            <div className="sb-usuario-identidade-topo">
              <span className="sb-object-id">{ehVoceMesmo ? "Identidade · você" : "Identidade"}</span>
              {/*
                O selo do frame: "Ativo" é quem já entrou, "Convite pendente" quem
                nunca entrou, "Suspenso" quem não consegue entrar (D-354). Só
                para ADMIN — sem a janela, o estado não tem fonte.
              */}
              {email !== null && (
                <span className="sb-status" style={TOM[memberStatusTone(status)]}>
                  {memberStatusLabel(status)}
                </span>
              )}
            </div>
            <h3 className="sb-usuario-nome">{nome ?? "sem nome no perfil"}</h3>
            {/* Sem janela (não-ADMIN), a linha não aparece — traço prometeria um dado escondido. */}
            {email !== null && <span className="sb-usuario-email">{email}</span>}
            {editavel && <EditarNome userId={userId} nome={nome} />}
          </div>

          {/* 2. O QUE PODE */}
          <div className="sb-drawer-card">
            <h4>Papel e permissões</h4>

            {/*
              UM DONO POR DADO: quem edita vê o CONTROLE, quem lê vê o SELO
              (D-297). Quem edita continua vendo o selo na tabela.
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
              Tom de ATENÇÃO, e o frame usa perigo: nesta casa `perigo` é coisa
              errada acontecendo, e aqui uma proteção está de pé.
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

          {/* 3. DESDE QUANDO */}
          <div style={{ marginTop: "var(--sb-space-3)" }}>
            <DetailRow
              label="Último acesso"
              value={ultimoAcesso}
              note={email === null ? "só um ADMIN enxerga o histórico de login" : undefined}
            />
            <DetailRow label="Membro desde" value={desde} />
            <DetailRow label="Identificador" value={<span className="sb-mono">{userId}</span>} />
          </div>

          {/* 4. COMO ENTRA */}
          {editavel && <ReemitirLink userId={userId} nome={nome ?? email ?? "esta pessoa"} />}

          {editavel && (
            <AcessoDoMembro
              organizationId={organizationId}
              userId={userId}
              nome={nome ?? email ?? "esta pessoa"}
              suspenso={status === "suspenso"}
              ehVoceMesmo={ehVoceMesmo}
              ehUltimoAdmin={ehUltimoAdmin}
            />
          )}

          {/* 5. O QUE MUDOU */}
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
