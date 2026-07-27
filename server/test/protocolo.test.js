// Testes do protocolo de atendimento (fila/protocolo.js): formato YYMMDD +
// 6 dígitos, gerado a partir da sequence global `seq_protocolo` (decisão da
// fundação FIL-58 — ver cabeçalho de fila/protocolo.js).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { gerarProtocolo } = require('../fila/protocolo');

// Simula nextval('seq_protocolo'): um contador ÚNICO e ATÔMICO, como a
// sequence real do Postgres — compartilhado entre "conexões" de tenants
// diferentes, porque a sequence não tem escopo de tenant nem é sujeita a RLS.
function fakeConnComSequenciaGlobal(contadorRef) {
  return {
    async execute(sql) {
      assert.match(sql, /nextval\('seq_protocolo'\)/);
      contadorRef.valor += 1;
      const seq = String(contadorRef.valor).padStart(6, '0');
      return { rows: [{ P: `260610${seq}` }] };
    },
  };
}

test('protocolo: formato YYMMDD + 6 dígitos', async () => {
  const conn = fakeConnComSequenciaGlobal({ valor: 0 });
  const p = await gerarProtocolo(conn);
  assert.match(p, /^\d{12}$/);
});

test('protocolo: dois tenants gerando no MESMO instante recebem valores distintos (sequence global)', async () => {
  const contador = { valor: 0 }; // representa a ÚNICA sequence do Postgres, para todos os tenants
  const connTenantA = fakeConnComSequenciaGlobal(contador);
  const connTenantB = fakeConnComSequenciaGlobal(contador);

  const [protA, protB] = await Promise.all([
    gerarProtocolo(connTenantA),
    gerarProtocolo(connTenantB),
  ]);

  assert.notEqual(protA, protB);
});
