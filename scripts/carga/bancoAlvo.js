// scripts/carga/bancoAlvo.js — Guarda do BANCO alvo (FIL-110, review do PR #67).
//
// `alvo.js` protege o caminho HTTP. Este arquivo protege o outro caminho, que
// é o perigoso: `semear` e `limpar` falam DIRETO com o Postgres de
// `DATABASE_URL` e nunca passam por `alvo.js`. `semear` provisiona usuários
// **ADMIN**; `limpar` faz DELETE em toda tabela com `tenant_id`. Uma connection
// string colada errada criava admin falso e apagava linha em produção, e a
// única checagem era que a variável **existia**.
//
// ── Três regras, todas fail-closed ─────────────────────────────────────────
//
// 1. **Confirmação positiva obrigatória.** Sem `CARGA_LAB=1` no ambiente ou
//    `--eu-sei-o-que-estou-fazendo` na linha de comando, recusa. Não existe
//    default permissivo: "esqueci de declarar" tem que falhar, não passar.
// 2. **Lista de recusa por igualdade de host, nunca por substring.** O host de
//    um endpoint do Neon é comparado inteiro. Comparar por sufixo/`includes` é
//    exatamente o erro que já mordeu este projeto em outro contexto
//    (`staging.olumechat.com.br` "contém" `olumechat.com.br`), e aqui ele
//    inverteria a guarda: um host de laboratório que por acaso contivesse o
//    texto de produção seria recusado, e — pior — a comparação frouxa dá falsa
//    sensação de cobertura.
// 3. **Prefixo com tamanho mínimo.** `limpar` apaga por `slug LIKE '<prefixo>%'`;
//    um prefixo curto ou vazio varreria tenants que não são do teste.
//
// ── O que esta guarda NÃO consegue fazer ───────────────────────────────────
// Uma connection string do Neon **não carrega o nome da branch** — `production`,
// `staging` e a efêmera diferem só pelo id do endpoint (`ep-...`). Então não há
// como deduzir "isto é produção" do texto: a lista de recusa cobre o que se
// sabe (e é extensível por `CARGA_BANCOS_PROIBIDOS`), e quem carrega a garantia
// de verdade é a regra 1. Por isso ela não tem default.
//
// Nada aqui imprime a connection string: só o host, que é o que o operador
// precisa ver para saber que errou o alvo.
'use strict';

/**
 * Endpoints que NUNCA podem receber semeadura/limpeza. Comparação por
 * igualdade de host. Estenda por `CARGA_BANCOS_PROIBIDOS` (lista separada por
 * vírgula) quando os endpoints de produção/staging forem conhecidos na máquina
 * que roda o harness — o valor não fica versionado aqui de propósito, é
 * configuração do ambiente.
 */
const BANCOS_PROIBIDOS = Object.freeze([]);

class BancoRecusado extends Error {}

/** Hosts extras de recusa vindos do ambiente. */
function proibidosDoAmbiente() {
  return String(process.env.CARGA_BANCOS_PROIBIDOS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Host de uma connection string, sem porta, sem credencial. `null` se ilegível. */
function hostDe(connectionString) {
  try {
    return new URL(connectionString).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Autoriza (ou recusa) uma operação de ESCRITA do harness no banco.
 *
 * @param {object} opcoes
 * @param {string} opcoes.connectionString  valor de DATABASE_URL
 * @param {boolean} [opcoes.confirmadoPorFlag]  `--eu-sei-o-que-estou-fazendo`
 * @param {string} [opcoes.prefixo]  prefixo dos tenants sintéticos
 * @param {Record<string,string|undefined>} [opcoes.env]  ambiente (injetável em teste)
 * @returns {{ host: string }}
 * @throws {BancoRecusado}
 */
function autorizarBanco({ connectionString, confirmadoPorFlag = false, prefixo = null, env = process.env }) {
  if (!connectionString || !String(connectionString).trim()) {
    throw new BancoRecusado(
      'DATABASE_URL ausente. Este comando escreve no banco e não tem para onde escrever.'
    );
  }

  const host = hostDe(connectionString);
  if (!host) {
    throw new BancoRecusado(
      'DATABASE_URL não é uma URL válida — recusado sem tentar conectar. ' +
      'Confira o valor (ele NÃO é impresso aqui de propósito).'
    );
  }

  const proibidos = new Set([
    ...BANCOS_PROIBIDOS,
    ...String(env.CARGA_BANCOS_PROIBIDOS || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  ]);
  if (proibidos.has(host)) {
    throw new BancoRecusado(
      `RECUSADO: o host "${host}" está na lista de bancos proibidos para carga. ` +
      'Este harness cria usuários ADMIN e apaga linhas — ele não roda contra ' +
      'banco de produção nem de staging, e não há flag que libere.'
    );
  }

  const confirmado = confirmadoPorFlag || String(env.CARGA_LAB || '') === '1';
  if (!confirmado) {
    throw new BancoRecusado(
      `RECUSADO: banco "${host}" não foi declarado como laboratório.\n` +
      'Este comando CRIA usuários ADMIN e APAGA linhas — ele exige confirmação ' +
      'positiva de que o alvo é descartável.\n' +
      'Se for mesmo um banco de laboratório (branch efêmera do Neon, banco local), ' +
      'declare de uma destas formas:\n' +
      '  CARGA_LAB=1 node scripts/carga/executar.js <cenário> …\n' +
      '  node scripts/carga/executar.js <cenário> --eu-sei-o-que-estou-fazendo\n' +
      'Confira o host acima ANTES: é ele que vai receber a escrita.'
    );
  }

  if (prefixo != null) {
    const p = String(prefixo);
    if (p.length < 6) {
      throw new BancoRecusado(
        `RECUSADO: prefixo "${p}" é curto demais (mínimo 6 caracteres). ` +
        'A limpeza apaga por "slug LIKE prefixo%" — prefixo curto varre tenant ' +
        'que não é do teste.'
      );
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(p)) {
      throw new BancoRecusado(
        `RECUSADO: prefixo "${p}" tem caractere fora de [a-z0-9-]. ` +
        'Curinga de LIKE ("%", "_") num prefixo transformaria a limpeza em ' +
        'varredura do banco inteiro.'
      );
    }
  }

  return { host };
}

module.exports = { autorizarBanco, BancoRecusado, hostDe, BANCOS_PROIBIDOS, proibidosDoAmbiente };
