'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LocalStorage, storageKey, verifyToken } = require('../storage');

test('storage: chave sempre começa pelo tenant do dono', () => {
  assert.equal(storageKey(17, 42, 'foto.jpg'), '17/42/foto.jpg');
  assert.equal(storageKey(17, 42, '../outro-tenant.jpg'), '17/42/outro-tenant.jpg');
});

test('storage local: tenant diferente não valida URL assinada', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'falatta-storage-'));
  const s = new LocalStorage({ dir });
  const key = storageKey(1, 9, 'foto.jpg');
  await s.salvar(Buffer.from('ok'), key, 'image/jpeg');
  const url = await s.urlAssinada(key, { expiresIn: 300 });
  const token = new URL(`http://local${url}`).searchParams.get('storage_token');
  assert.equal(s.verificar(token, key).key, key);
  assert.equal(s.verificar(token, '2/9/foto.jpg'), false);
  assert.equal(verifyToken(token, key, Date.now() + 301000), false);
  await fs.rm(dir, { recursive: true, force: true });
});
