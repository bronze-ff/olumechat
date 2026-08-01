// scripts/carga/semear.js — Tenants e usuários sintéticos do teste de carga (FIL-110).
//
// Roda com acesso DIRETO ao banco do ambiente alvo (DATABASE_URL), não pela
// API: criar 20 tenants pelo painel do operador exigiria uma sessão de operador
// e mediria o provisionamento, não o que o ticket pede.
//
// ── Por que o caminho do produto, e não INSERT à mão ────────────────────────
// O tenant nasce por `operador/tenants.provisionar()` — a mesma transação que o
// painel usa. Um tenant sintético montado a dedo poderia sair sem o atendente
// ADMIN vinculado (`atendente.matricula = usuario.id`) e o teste mediria um
// estado que não existe em produção.
//
// A senha é definida por UPDATE direto em `usuario.senha_hash` porque o
// caminho do produto é um link de convite por e-mail — que não existe aqui. O
// hash é gerado uma única vez e reaproveitado: argon2id a 19 MiB × 20 tenants ×
// N usuários levaria minutos e não mede nada. O LOGIN continua pagando o
// argon2id inteiro, que é o custo que interessa medir.
//
// ── Limpeza ────────────────────────────────────────────────────────────────
// `--limpar` apaga TUDO que tenha `tenant_id` dos tenants do prefixo,
// descobrindo as tabelas pelo information_schema e repetindo o passe até não
// haver mais violação de FK. Lista fixa de tabelas apodrece: migração nova
// entra e o dado sintético fica para trás, num ambiente que a gente jura estar
// limpo.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PREFIXO_PADRAO = 'carga-fil110';
const ARQUIVO_SEMENTE = path.join(__dirname, '.semente.json');
const LOTE = 200; // linhas por INSERT ao semear usuários (ver o laço)

/**
 * Senha SORTEADA a cada semeadura, nunca fixa no código.
 *
 * Uma constante versionada viraria credencial pública de um usuário ADMIN que
 * existe de verdade no banco do ambiente alvo — e bastaria uma limpeza esquecida
 * em staging para que "senha de teste" virasse porta aberta. A senha vive só no
 * `.semente.json` (fora do git) e some com `limpar`.
 */
const sortearSenha = () => `Cg!${crypto.randomBytes(18).toString('base64url')}`;

/** Carrega os módulos do server com o cwd certo (dotenv, MEDIA_DIR etc.). */
function requererServer(rel) {
  return require(path.join(__dirname, '..', '..', 'server', rel));
}

async function semear({ tenants = 20, usuarios = 10, prefixo = PREFIXO_PADRAO, senha = sortearSenha() } = {}) {
  const provisionamento = requererServer('operador/tenants');
  const { comOperador, entrarNoTenant } = requererServer('operador/db');
  const senhas = requererServer('auth/senha');

  const hash = await senhas.gerarHash(senha); // uma vez só — ver cabeçalho
  const criados = [];

  for (let t = 1; t <= tenants; t += 1) {
    const slug = `${prefixo}-t${String(t).padStart(2, '0')}`;
    const email = `admin@${slug}.invalid`; // .invalid é reservado (RFC 2606): não existe rota de e-mail
    const r = await provisionamento.provisionar({
      nome: `Carga FIL-110 tenant ${t}`,
      slug,
      admin: { email, nome: `Admin ${t}` },
      operador: { id: null, email: 'harness-carga@local' },
    });
    const tenantId = Number(r.tenant.ID);
    const conta = { slug, tenantId, usuarios: [] };

    await comOperador(async (conn) => {
      await entrarNoTenant(conn, tenantId);
      // Admin: define a senha do usuário criado pelo provisionamento.
      await conn.execute(
        `UPDATE usuario SET senha_hash = :hash WHERE tenant_id = :t AND id = :id`,
        { hash, t: tenantId, id: Number(r.usuario.ID) }
      );
      conta.usuarios.push({ email, senha, papel: 'ADMIN', usuarioId: Number(r.usuario.ID), nome: `Admin ${t}` });

      // Demais atendentes do tenant, em LOTES.
      //
      // Uma linha por ida ao banco custaria 2 idas × N usuários: com ~45 ms de
      // ida e volta, semear os 6.400 usuários que a rampa exige (uma identidade
      // por conexão, ver cenario-sse.js) levaria mais de dez minutos e o teste
      // viraria o gargalo do teste. Em lotes de 200, são dezenas de idas.
      for (let base = 1; base < usuarios; base += LOTE) {
        const fim = Math.min(usuarios, base + LOTE);
        const linhas = [];
        const binds = { t: tenantId, hash };
        for (let u = base; u < fim; u += 1) {
          linhas.push(`(:t, :e${u}, :n${u}, :hash)`);
          binds[`e${u}`] = `atd${String(u).padStart(4, '0')}@${slug}.invalid`;
          binds[`n${u}`] = `Atendente ${u}`;
        }
        const ins = await conn.execute(
          `INSERT INTO usuario (tenant_id, email, nome, senha_hash)
           VALUES ${linhas.join(', ')} RETURNING id, email, nome`,
          binds
        );
        // A ordem do RETURNING de um INSERT multi-linha segue a ordem dos
        // VALUES, mas não se depende disso aqui: o vínculo é feito pelo e-mail
        // que voltou, e `atendente.matricula = usuario.id` é a convenção da
        // migração 004.
        const linhasAtd = [];
        const bindsAtd = { t: tenantId };
        ins.rows.forEach((linha, i) => {
          const usuarioId = Number(linha.ID);
          linhasAtd.push(`(:t, :m${i}, :an${i}, 'ATENDENTE', 'S')`);
          bindsAtd[`m${i}`] = usuarioId;
          bindsAtd[`an${i}`] = linha.NOME;
          conta.usuarios.push({ email: linha.EMAIL, senha, papel: 'ATENDENTE', usuarioId, nome: linha.NOME });
        });
        await conn.execute(
          `INSERT INTO atendente (tenant_id, matricula, nome, papel, pode_ativo)
           VALUES ${linhasAtd.join(', ')}`,
          bindsAtd
        );
      }

      // Uma conversa por tenant, com id conhecido. É o que torna a checagem de
      // isolamento REST uma asserção de verdade: sem dado nenhum, "o tenant A
      // não viu nada do B" passaria por vacuidade, num ambiente vazio.
      const insContato = await conn.execute(
        `INSERT INTO contato (tenant_id, telefone, nome_perfil)
         VALUES (:t, :tel, :nome) RETURNING id`,
        { t: tenantId, tel: `55${String(9000000000 + tenantId).slice(0, 11)}`, nome: `Contato carga ${t}` }
      );
      const insConversa = await conn.execute(
        `INSERT INTO conversa (tenant_id, contato_id, status, ultima_msg_em)
         VALUES (:t, :c, 'aberta', now()) RETURNING id`,
        { t: tenantId, c: Number(insContato.rows[0].ID) }
      );
      conta.conversaId = Number(insConversa.rows[0].ID);
    });

    criados.push(conta);
    if (t % 5 === 0 || t === tenants) process.stdout.write(`  semeados ${t}/${tenants} tenants\n`);
  }

  const semente = { prefixo, criadoEm: new Date().toISOString(), tenants: criados };
  fs.writeFileSync(ARQUIVO_SEMENTE, JSON.stringify(semente, null, 2));
  console.log(`\nSemente gravada em ${ARQUIVO_SEMENTE} (fora do git — contém senha).`);
  return semente;
}

/** Apaga todo dado dos tenants do prefixo e os próprios tenants. */
async function limpar({ prefixo = PREFIXO_PADRAO } = {}) {
  const { comOperador } = requererServer('operador/db');

  const removidos = await comOperador(async (conn) => {
    const alvo = await conn.execute(
      `SELECT id, slug FROM tenant WHERE slug LIKE :p ORDER BY id`,
      { p: `${prefixo}%` }
    );
    const ids = alvo.rows.map((r) => Number(r.ID));
    if (!ids.length) return { ids: [], tabelas: {} };

    const lista = ids.join(',');
    const tabelas = await conn.execute(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'tenant_id'
          AND table_name <> 'tenant'
        GROUP BY table_name`
    );
    const nomes = tabelas.rows.map((r) => r.TABLE_NAME);

    // Passes sucessivos: uma FK entre duas tabelas de tenant faz a primeira
    // tentativa falhar, e a ordem certa aparece sozinha no passe seguinte.
    //
    // Cada DELETE vai dentro de um SAVEPOINT: no Postgres, um erro aborta a
    // TRANSAÇÃO inteira ("current transaction is aborted"), então sem o
    // savepoint a primeira violação de FK derrubaria toda a limpeza — e o
    // ambiente ficaria com dado sintético justamente porque a limpeza tentou
    // ser tolerante.
    const contagem = {};
    let restantes = [...nomes];
    for (let passe = 0; passe < 6 && restantes.length; passe += 1) {
      const falharam = [];
      for (const tabela of restantes) {
        await conn.execute('SAVEPOINT limpeza');
        try {
          const r = await conn.execute(`DELETE FROM "${tabela}" WHERE tenant_id IN (${lista})`);
          await conn.execute('RELEASE SAVEPOINT limpeza');
          if (r.rowsAffected) contagem[tabela] = (contagem[tabela] || 0) + r.rowsAffected;
        } catch (err) {
          await conn.execute('ROLLBACK TO SAVEPOINT limpeza');
          if (err.code === '23503') { falharam.push(tabela); continue; } // FK: tenta no próximo passe
          throw err;
        }
      }
      if (falharam.length === restantes.length) {
        throw new Error(`Não foi possível apagar (ciclo de FK): ${falharam.join(', ')}`);
      }
      restantes = falharam;
    }

    const t = await conn.execute(`DELETE FROM tenant WHERE id IN (${lista})`);
    contagem.tenant = t.rowsAffected;
    return { ids, slugs: alvo.rows.map((r) => r.SLUG), tabelas: contagem };
  });

  if (fs.existsSync(ARQUIVO_SEMENTE)) fs.unlinkSync(ARQUIVO_SEMENTE);
  return removidos;
}

function carregarSemente() {
  if (!fs.existsSync(ARQUIVO_SEMENTE)) {
    throw new Error(`Semente não encontrada (${ARQUIVO_SEMENTE}). Rode "semear" antes.`);
  }
  return JSON.parse(fs.readFileSync(ARQUIVO_SEMENTE, 'utf8'));
}

module.exports = { semear, limpar, carregarSemente, PREFIXO_PADRAO, sortearSenha, ARQUIVO_SEMENTE };
