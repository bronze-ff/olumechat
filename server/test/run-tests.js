'use strict';

// Os testes legados de Graph usam o mock do token global. Isso é habilitado
// somente neste processo de teste; o servidor nunca liga o fallback sozinho.
//
// FIL-98: os testes de isolamento entre tenants (RLS) contra Postgres real são
// gated por TEST_DATABASE_URL — sem ela o node:test os marca como `skipped` e
// a suíte termina VERDE. Isso é aceitável no laptop, mas na CI seria um teste
// de segurança se disfarçando de teste que passou. Com RLS_OBRIGATORIO=1 este
// runner passa a exigir que NENHUM teste tenha sido pulado: hoje todo `skip`
// da suíte é exatamente esse gate (`grep -rn "skip:" test/`), então "zero
// pulados" é a checagem mais simples que não envelhece com nomes de teste.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = { ...process.env, DEV_META_FALLBACK: process.env.DEV_META_FALLBACK || '1' };
const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).map((f) => path.join(__dirname, f));

const estrito = process.env.RLS_OBRIGATORIO === '1';
// Em modo estrito o TAP vai para um arquivo (para ser conferido no fim) e o
// `spec` continua indo para o terminal — a saída do job segue legível.
const tap = estrito ? path.join(os.tmpdir(), `olume-suite-${process.pid}.tap`) : null;
const reporters = estrito
  ? ['--test-reporter=spec', '--test-reporter-destination=stdout',
     '--test-reporter=tap', `--test-reporter-destination=${tap}`]
  : [];

// Muitos testes substituem o singleton de banco por implementações em memória.
// Rodá-los em paralelo faz um arquivo sobrescrever o mock de outro e gera
// falhas espúrias; a aplicação continua concorrente, mas a suíte é serial.
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...reporters, ...files], { stdio: 'inherit', env });
const status = r.status == null ? 1 : r.status;

if (!estrito) process.exit(status);

// --- Modo estrito (CI): teste pulado não pode se disfarçar de teste que passou.
let saida;
try {
  saida = fs.readFileSync(tap, 'utf8');
} catch (err) {
  console.error(`\n[suite] RLS_OBRIGATORIO=1 mas o relatório TAP não foi gerado (${err.message})`);
  process.exit(status || 1);
}
fs.rmSync(tap, { force: true });

// O resumo do TAP fica no fim; `# skipped N` só aparece sem indentação no
// total geral (subtestes aninhados vêm indentados), e conta os aninhados.
const total = (campo) => {
  const achados = [...saida.matchAll(new RegExp(`^# ${campo} (\\d+)$`, 'gm'))];
  return achados.length ? Number(achados[achados.length - 1][1]) : null;
};
const pulados = total('skipped');
const passaram = total('pass');

const nomeDe = (linha) => linha.replace(/^\s*(?:not )?ok \d+ - /, '').replace(/ # (SKIP|TODO).*$/, '');
const linhas = saida.split('\n');
const nomesPulados = linhas.filter((l) => /^\s*ok \d+ - .* # SKIP/.test(l)).map(nomeDe);
// Prova visível no log do job: os testes que só existem com banco de verdade.
const comBancoReal = linhas
  .filter((l) => /^\s*ok \d+ - /.test(l) && !/ # SKIP/.test(l))
  .map(nomeDe)
  .filter((n) => /RLS real:|no Postgres real/i.test(n));

const problemas = [];
if (pulados === null || passaram === null) problemas.push('não consegui ler o resumo do TAP (formato inesperado)');
if (pulados) problemas.push(`${pulados} teste(s) PULADO(S) — com RLS_OBRIGATORIO=1 nenhum teste pode ser pulado`);
if (!comBancoReal.length) problemas.push('nenhum teste contra Postgres real executou (TEST_DATABASE_URL ausente ou inválida?)');

console.log(`\n[suite] RLS_OBRIGATORIO=1 — ${comBancoReal.length} teste(s) contra Postgres real executado(s):`);
for (const n of comBancoReal) console.log(`[suite]   ✓ ${n}`);
for (const n of nomesPulados) console.log(`[suite]   ↷ PULADO: ${n}`);

if (problemas.length) {
  console.error('\n[suite] FALHOU o portão de testes com banco real:');
  for (const p of problemas) console.error(`[suite]   - ${p}`);
  console.error('[suite] Teste que não roda não pode se disfarçar de teste que passou (FIL-98).');
  process.exit(status || 1);
}
process.exit(status);
