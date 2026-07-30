// test/ci-rls-obrigatorio.test.js — FIL-98
//
// O portão de RLS na CI é feito de duas metades que só funcionam juntas:
//   (1) o job `server-test-rls` do .github/workflows/ci.yml, que dá um Postgres
//       real à suíte (TEST_DATABASE_URL) depois de aplicar as migrações;
//   (2) o RLS_OBRIGATORIO=1 do test/run-tests.js, que faz teste PULADO virar
//       falha.
// Tirar qualquer uma das duas não quebra nada visivelmente — a CI só volta a
// ficar verde sem ter provado isolamento nenhum, que é exatamente o silêncio
// que este ticket veio matar. Estes testes são o alarme desse silêncio.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Normaliza CRLF: no Windows o checkout pode trazer o YAML com \r\n e os
// recortes por linha abaixo passariam a não casar nada (falso verde).
const ler = (...p) => fs.readFileSync(path.join(...p), 'utf8').replace(/\r\n/g, '\n');
const CI = ler(__dirname, '..', '..', '.github', 'workflows', 'ci.yml');
const RUNNER = ler(__dirname, 'run-tests.js');

// Recorta o bloco de um job do ci.yml (do nome do job até o próximo job no
// mesmo nível de indentação).
function jobDe(nome) {
  const m = CI.match(new RegExp(`^  ${nome}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|^[^\\s#])`, 'm'));
  return m ? m[1] : null;
}

test('CI: existe o job server-test-rls', () => {
  assert.ok(jobDe('server-test-rls'), 'job server-test-rls sumiu do .github/workflows/ci.yml');
});

test('CI: o job levanta um Postgres real como service container', () => {
  const job = jobDe('server-test-rls');
  assert.match(job, /services:/);
  assert.match(job, /image: postgres:\d+/, 'sem service container de Postgres não há RLS para testar');
  assert.match(job, /pg_isready/, 'sem healthcheck o job corre contra um banco que ainda não subiu');
});

test('CI: as migrações são aplicadas ANTES da suíte', () => {
  const job = jobDe('server-test-rls');
  const migrar = job.indexOf('npm run migrar');
  const testar = job.indexOf('run: npm test');
  assert.ok(migrar > -1, 'o job precisa aplicar as migrações no Postgres da CI');
  assert.ok(testar > -1, 'o job precisa rodar a suíte');
  assert.ok(migrar < testar, 'a suíte rodaria contra um banco sem tabela nenhuma');
});

test('CI: a suíte roda com TEST_DATABASE_URL e RLS_OBRIGATORIO=1', () => {
  const job = jobDe('server-test-rls');
  assert.match(job, /TEST_DATABASE_URL: postgres:\/\//, 'sem TEST_DATABASE_URL os testes de RLS são pulados');
  assert.match(job, /RLS_OBRIGATORIO: '1'/, 'sem RLS_OBRIGATORIO teste pulado volta a contar como sucesso');
});

test('CI: as URLs do job são diretas (o migrar recusa host com "-pooler")', () => {
  const job = jobDe('server-test-rls');
  const urls = [...job.matchAll(/postgres:\/\/\S+/g)].map((m) => m[0]);
  assert.ok(urls.length >= 2, 'o job precisa de DATABASE_URL (migração) e TEST_DATABASE_URL (suíte)');
  for (const u of urls) {
    assert.ok(!/-pooler/.test(u), `scripts/migrar.js aborta contra pooler (o lock é de sessão): ${u}`);
  }
});

test('runner: RLS_OBRIGATORIO=1 falha se algum teste foi pulado', () => {
  assert.match(RUNNER, /RLS_OBRIGATORIO/, 'o portão de teste pulado sumiu do run-tests.js');
  assert.match(RUNNER, /--test-reporter=tap/, 'sem o relatório TAP não dá para saber o que foi pulado');
  assert.match(RUNNER, /PULADO\(S\)/, 'o runner precisa reprovar explicitamente teste pulado');
});
