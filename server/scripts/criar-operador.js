// scripts/criar-operador.js — Cria a conta de OPERADOR (super-admin) do
// Olume. É o bootstrap do painel do FIL-70.
//
//   cd server
//   npm run criar-operador -- --email=voce@olumechat.com.br --nome="Seu Nome" --senha='...'
//
// Ou sem --senha, lendo de variável de ambiente (não fica no histórico do
// shell nem na lista de processos):
//
//   OPERADOR_SENHA='...' npm run criar-operador -- --email=voce@olumechat.com.br
//
// POR QUE UM SCRIPT, E NÃO UM ENDPOINT: um "criar operador" exposto em HTTP
// seria a porta dos fundos do sistema inteiro — o operador enxerga todos os
// tenants. Quem cria um operador precisa já ter acesso ao banco.
'use strict';

const contas = require('../operador/contas');
const db = require('../db/pool');

function arg(nome) {
  const p = process.argv.find((a) => a.startsWith(`--${nome}=`));
  return p ? p.slice(nome.length + 3) : null;
}

async function main() {
  const email = arg('email');
  const nome = arg('nome');
  const senha = arg('senha') || process.env.OPERADOR_SENHA;

  if (!email || !senha) {
    console.error('uso: npm run criar-operador -- --email=voce@olumechat.com.br [--nome="Seu Nome"] --senha=...');
    console.error('     (ou defina OPERADOR_SENHA no ambiente em vez de --senha)');
    process.exit(1);
  }

  const o = await contas.criar({ email, nome, senha });
  console.log(`[operador] criado: #${o.id} ${o.email}`);
}

main()
  .catch((err) => {
    // Nunca ecoa a senha — nem em erro de validação (a mensagem vem de
    // auth/senha.js::validarForca, que também não a inclui).
    if (err.code === '23505') {
      console.error('[operador] já existe um operador com esse e-mail.');
    } else {
      console.error('[operador] erro:', err.message);
    }
    process.exitCode = 1;
  })
  .finally(() => db.closePool().catch(() => {}));
