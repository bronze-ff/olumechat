// FIL-113 — o marcador de versão que o smoke de deploy usa para provar qual
// build está no ar.
//
// O que estes testes protegem, em ordem de importância:
//
//   1. ausência NUNCA vira palpite. Um marcador que "chuta" faria o smoke passar
//      justamente no caso que ele existe para pegar: container velho atendendo;
//   2. o valor não pode vir de variável de ambiente — configuração é editável e
//      copiada à mão entre aplicações do Coolify (docs/AMBIENTES.md), então um
//      marcador vindo dali poderia AFIRMAR uma versão que a imagem não tem;
//   3. as duas implementações do contrato (server CommonJS e build do client em
//      ESM) não podem divergir — quem verifica lê a mesma forma nos dois lados;
//   4. as respostas de /health/* precisam de fato carregar o campo, inclusive a
//      de 503: quando o banco cai, "qual build está atendendo?" é a primeira
//      pergunta.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const versaoMod = require('../versao');
const { derivar, lerArquivo } = versaoMod;

const SHA_COMPLETO = '0123456789abcdef0123456789abcdef01234567';
const VERSAO_JS = fs.readFileSync(path.join(__dirname, '..', 'versao.js'), 'utf8');
const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('derivar: SHA completo vira sha/curto/tag, e a tag é exatamente a do GHCR', () => {
  const v = derivar(SHA_COMPLETO);
  assert.deepEqual(v, {
    sha: SHA_COMPLETO,
    curto: '0123456',
    tag: 'sha-0123456',
    origem: 'build',
  });
  // A CI publica `sha-${GITHUB_SHA:0:7}` e o deploy grava essa mesma string no
  // Coolify. Se estes 7 caracteres mudarem, a comparação do smoke passa a
  // comparar coisas diferentes — e casaria só por acidente.
  assert.equal(v.tag, `sha-${SHA_COMPLETO.slice(0, 7)}`);
});

test('derivar: normaliza espaço e maiúsculas (o arquivo pode vir com \\n do build)', () => {
  assert.deepEqual(derivar(`  ${SHA_COMPLETO.toUpperCase()}\n`), derivar(SHA_COMPLETO));
});

test('derivar: SHA curto (7) é aceito; tag e sha coincidem', () => {
  const v = derivar('abc1234');
  assert.equal(v.origem, 'build');
  assert.equal(v.curto, 'abc1234');
  assert.equal(v.tag, 'sha-abc1234');
});

test('derivar: o que não é SHA vira "desconhecida" com TODOS os campos nulos — nunca um palpite', () => {
  const desconhecida = { sha: null, curto: null, tag: null, origem: 'desconhecida' };
  for (const entrada of ['', '   ', null, undefined, 'abc123', 'zzzzzzz', 'dev', 'latest',
    `${SHA_COMPLETO}f`, 'sha-abc1234', '0123456 789abcd', {}, 42]) {
    assert.deepEqual(derivar(entrada), desconhecida, `entrada ${JSON.stringify(entrada)} não deveria virar marcador`);
  }
});

test('lerArquivo: lê o SHA gravado na imagem; arquivo ausente é "desconhecida", não erro', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olume-versao-'));
  try {
    const arquivo = path.join(dir, 'BUILD_SHA');
    fs.writeFileSync(arquivo, `${SHA_COMPLETO}\n`);
    assert.deepEqual(lerArquivo(arquivo), derivar(SHA_COMPLETO));

    assert.deepEqual(lerArquivo(path.join(dir, 'nao-existe')),
      { sha: null, curto: null, tag: null, origem: 'desconhecida' });

    // Build sem `--build-arg` grava o arquivo VAZIO — não pode virar marcador.
    fs.writeFileSync(arquivo, '');
    assert.equal(lerArquivo(arquivo).origem, 'desconhecida');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('versao.js NÃO lê variável de ambiente — versão declarada por fora do build poderia mentir', () => {
  // Só o código: o cabeçalho do módulo cita `process.env` justamente para
  // explicar por que não o usa.
  const codigo = VERSAO_JS.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(codigo, /process\.env/,
    'o marcador tem que vir do arquivo gravado no build; env do Coolify é configuração editável (docs/AMBIENTES.md)');
});

test('o Dockerfile grava o arquivo que versao.js lê, a partir do build-arg', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', '..', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /ARG OLUME_COMMIT_SHA/);
  assert.match(dockerfile, /> ?\/app\/BUILD_SHA/,
    'o Dockerfile precisa gravar /app/BUILD_SHA — é o caminho que versao.js lê (ARQUIVO_PADRAO)');
  assert.equal(path.basename(versaoMod.ARQUIVO_PADRAO), 'BUILD_SHA');
});

test('/health/live e /health/ready devolvem o marcador — inclusive a resposta 503', () => {
  const inicioLive = APP_JS.indexOf("app.get('/health/live'");
  assert.ok(inicioLive > 0, 'app.js deveria ter a rota /health/live');
  const trechoLive = APP_JS.slice(inicioLive, inicioLive + 300);
  assert.match(trechoLive, /versao/, '/health/live precisa carregar o marcador de versão');

  const inicio = APP_JS.indexOf('async function readiness');
  const corpo = APP_JS.slice(inicio, APP_JS.indexOf('\n}', inicio));
  const ok = corpo.slice(corpo.indexOf("status: 'ok'"));
  assert.match(ok.slice(0, 200), /versao/, 'a resposta 200 de readiness precisa carregar o marcador');
  const erro = corpo.slice(corpo.indexOf('res.status(503)'));
  assert.match(erro.slice(0, 200), /versao/,
    'a resposta 503 também: quando o banco cai, saber QUAL build atendeu é a primeira pergunta');
});

test('contrato único: o gerador do frontend produz exatamente o mesmo objeto que o server', async () => {
  // Duas implementações (CommonJS aqui, ESM no build do Vite) para o MESMO
  // contrato. O smoke de staging lê a forma do server e o smoke de produção do
  // FIL-101 vai ler a do frontend — divergência entre elas apareceria como
  // "versão não confere" num deploy que estava certo.
  const gerador = await import(
    require('node:url').pathToFileURL(
      path.join(__dirname, '..', '..', 'client', 'scripts', 'gerar-version-json.mjs')
    ).href
  );
  for (const entrada of [SHA_COMPLETO, `  ${SHA_COMPLETO.toUpperCase()}\n`, 'abc1234', '', 'dev', undefined]) {
    assert.deepEqual(gerador.derivar(entrada), derivar(entrada),
      `server e client divergiram para ${JSON.stringify(entrada)}`);
  }
});

test('o gerador do frontend escreve o JSON no destino pedido, e não escreve ao ser importado', async () => {
  const gerador = await import(
    require('node:url').pathToFileURL(
      path.join(__dirname, '..', '..', 'client', 'scripts', 'gerar-version-json.mjs')
    ).href
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olume-versao-front-'));
  try {
    const destino = path.join(dir, 'version.json');
    gerador.gerar(destino, SHA_COMPLETO);
    assert.deepEqual(JSON.parse(fs.readFileSync(destino, 'utf8')), derivar(SHA_COMPLETO));

    // Importar não pode escrever nada: o módulo é importado por este teste e o
    // destino padrão é relativo ao cwd (`dist/version.json`). Sem a guarda de
    // "chamado direto", `npm test` passaria a cuspir arquivo dentro de server/.
    const vazio = fs.mkdtempSync(path.join(os.tmpdir(), 'olume-versao-import-'));
    const url = require('node:url').pathToFileURL(
      path.join(__dirname, '..', '..', 'client', 'scripts', 'gerar-version-json.mjs')
    ).href;
    const r = require('node:child_process').spawnSync(
      process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)});`],
      { cwd: vazio, encoding: 'utf8', env: { ...process.env, OLUME_COMMIT_SHA: SHA_COMPLETO } }
    );
    assert.equal(r.status, 0, `importar o gerador falhou: ${r.stderr}`);
    assert.deepEqual(fs.readdirSync(vazio), [], 'importar o gerador não pode escrever arquivo nenhum');
    fs.rmSync(vazio, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('o smoke do deploy compara a versão servida e o Nginx serve /version.json', () => {
  const raiz = path.join(__dirname, '..', '..');
  const deploy = fs.readFileSync(path.join(raiz, '.github', 'workflows', 'deploy-staging.yml'), 'utf8');
  // O campo lido pelo smoke é o mesmo que app.js devolve. Renomear um sem o
  // outro deixaria o smoke comparando `""` com o SHA — e ele falha fechado,
  // mas por motivo errado e a cada deploy.
  assert.match(deploy, /\.versao\.sha/,
    'o smoke precisa ler versao.sha da resposta de /health/ready');
  assert.match(deploy, /SHA_ESPERADO/,
    'o smoke precisa comparar com o SHA que este job deployou');

  const nginx = fs.readFileSync(path.join(raiz, 'client', 'nginx.conf'), 'utf8');
  const loc = nginx.indexOf('location = /version.json');
  assert.ok(loc > 0, 'o Nginx precisa de um location próprio para /version.json');
  assert.ok(loc < nginx.indexOf('location / {'),
    'o location de /version.json tem que vir ANTES do fallback de SPA, senão um arquivo ausente vira index.html com 200');
});
