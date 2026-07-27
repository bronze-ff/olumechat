// Testes de ISOLAMENTO DE TENANT de metricas.js/historico.js (FIL-65) —
// requisito de SEGURANÇA (docs/PORTE.md §1.2), critério de aceite do ticket.
//
// Mesma estratégia de "Postgres de mentira" de test/db-tenant.test.js: um
// client falso que respeita a semântica que importa (set_config local,
// filtragem por tenant do contexto) e é embrulhado pelo MESMO wrapper de
// conexão de db/pool.js. O db.comTenant() usado aqui é o de VERDADE — só
// db.getConnection() é trocado — para provar que a rota + comTenant() juntos
// isolam, não um mock que já assume a resposta certa.
'use strict';

process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const db = require('../db/pool');
const { SECRET } = require('../auth/secret');
const authMiddleware = require('../auth/middleware');

const TOKEN = jwt.sign({ jti: 'tm-tenant', matricula: 999, nome: 'Teste' }, SECRET, { expiresIn: '1h' });

/** Client falso: filtra `conversa`/`contato` pelo tenant do set_config vigente
 *  (emula a policy de RLS da migração 001) e responde às queries específicas
 *  de metricas.js/historico.js pelo trecho que as identifica. */
function criarClientFalso({ conversas = [], contatos = [] } = {}) {
  const estado = { ctxTransacao: null, roleTransacao: null };
  const ctx = () => estado.ctxTransacao;
  const conversasVisiveis = () => conversas.filter((c) => String(c.tenant_id) === String(ctx()));

  return {
    estado,
    async query(text, values = []) {
      const t = text.trim();
      if (/^BEGIN/i.test(t)) return { rows: [], rowCount: 0 };
      if (/^(COMMIT|ROLLBACK)/i.test(t)) {
        estado.ctxTransacao = null;
        estado.roleTransacao = null;
        return { rows: [], rowCount: 0 };
      }
      if (/^SET\s+LOCAL\s+ROLE/i.test(t)) { estado.roleTransacao = 'falatta_app'; return { rows: [], rowCount: 0 }; }
      if (/set_config\(/i.test(t)) { estado.ctxTransacao = values[0]; return { rows: [{ set_config: values[0] }], rowCount: 1 }; }

      // metricas.js: query de totais.
      if (/AS TOTAL/.test(t)) {
        const rows = conversasVisiveis();
        return {
          rows: [{
            total: rows.length,
            resolvidas: rows.filter((r) => r.fila_status === 'resolvida').length,
            aguardando: rows.filter((r) => r.fila_status === 'aguardando').length,
            em_atendimento: 0, no_bot: 0, ativas: 0, receptivas: 0,
            espera_media_seg: null, tmr_medio_seg: null, duracao_media_seg: null,
          }],
          rowCount: 1,
        };
      }
      // historico.js: contagem total (sem GROUP BY — não confundir com /contagens).
      if (/AS QTD/i.test(t) && !/GROUP BY/i.test(t) && /FROM conversa/i.test(t)) {
        return { rows: [{ qtd: conversasVisiveis().length }], rowCount: 1 };
      }
      // historico.js: listagem paginada (SELECT_BASE, identificado pelo alias ULTIMA_MSG).
      if (/ULTIMA_MSG/.test(t)) {
        const rows = conversasVisiveis().map((c) => {
          const ct = contatos.find((x) => x.id === c.contato_id) || {};
          return {
            id: c.id, protocolo: c.protocolo, fila_status: c.fila_status, origem: c.origem,
            criado_em: c.criado_em, fila_entrou_em: null, atribuida_em: null, resolvida_em: null,
            nome_perfil: ct.nome_perfil, telefone: ct.telefone, codcli: ct.codcli,
            departamento: null, atendente: null,
          };
        });
        return { rows, rowCount: rows.length, fields: rows.length ? Object.keys(rows[0]).map((name) => ({ name })) : [] };
      }
      // demais sub-queries do /resumo (porDia, porDepto, porAtendente, porDiaAtendente): vazio.
      return { rows: [], rowCount: 0, fields: [] };
    },
    release() {},
  };
}

/** Troca db.getConnection() por uma fábrica que embrulha SEMPRE o mesmo client
 *  falso (estado de tenant persiste nele) num wrapper NOVO a cada chamada —
 *  do contrário o 2º comTenant() bateria numa conexão já fechada pelo 1º. */
function comConexaoFalsa(client) {
  const original = db.getConnection;
  db.getConnection = async () => db._wrapClient(client);
  return () => { db.getConnection = original; };
}

function startApp(rotas, perfil, tenantId) {
  const app = express();
  app.use('/api', express.json());
  for (const [caminho, router] of rotas) {
    app.use(caminho, authMiddleware, (req, res, next) => { req.perfil = perfil; req.tenantId = tenantId; next(); }, router);
  }
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve({ server: s, port: s.address().port }));
  });
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path, headers: { authorization: `Bearer ${TOKEN}` } },
      (res) => { let o = ''; res.on('data', (c) => (o += c)); res.on('end', () => resolve({ status: res.statusCode, body: o })); }
    ).on('error', reject);
  });
}

const PERFIL_ADMIN = { atendenteId: 1, papel: 'ADMIN', deptoIds: [], ativo: true };

test('metricas: tenant B não soma os atendimentos do tenant A', async () => {
  const conversas = [
    { id: 1, tenant_id: '1', contato_id: 1, protocolo: '260701000001', fila_status: 'resolvida', origem: 'receptiva', departamento_id: null, atendente_id: null, criado_em: new Date() },
    { id: 2, tenant_id: '1', contato_id: 1, protocolo: '260701000002', fila_status: 'resolvida', origem: 'receptiva', departamento_id: null, atendente_id: null, criado_em: new Date() },
    { id: 3, tenant_id: '1', contato_id: 1, protocolo: '260701000003', fila_status: 'aguardando', origem: 'ativa', departamento_id: null, atendente_id: null, criado_em: new Date() },
    { id: 4, tenant_id: '2', contato_id: 2, protocolo: '260701000004', fila_status: 'resolvida', origem: 'receptiva', departamento_id: null, atendente_id: null, criado_em: new Date() },
  ];
  const client = criarClientFalso({ conversas });
  const restaurar = comConexaoFalsa(client);
  try {
    const { server, port } = await startApp([['/api/metricas', require('../api/metricas')]], PERFIL_ADMIN, 1);
    try {
      const r = await get(port, '/api/metricas/resumo');
      assert.equal(r.status, 200);
      assert.equal(JSON.parse(r.body).totais.total, 3, 'tenant 1 deveria ver só os 3 atendimentos dele');
    } finally { server.close(); }

    const { server: server2, port: port2 } = await startApp([['/api/metricas', require('../api/metricas')]], PERFIL_ADMIN, 2);
    try {
      const r2 = await get(port2, '/api/metricas/resumo');
      assert.equal(r2.status, 200);
      const totalB = JSON.parse(r2.body).totais.total;
      assert.equal(totalB, 1, 'tenant 2 deveria ver só o 1 atendimento dele — VAZAMENTO se somar o do tenant 1');
    } finally { server2.close(); }
  } finally { restaurar(); }
});

test('historico: busca do tenant A não retorna conversa do tenant B', async () => {
  const contatos = [
    { id: 1, tenant_id: '1', nome_perfil: 'Cliente do A', telefone: '5562900000001', codcli: null },
    { id: 2, tenant_id: '2', nome_perfil: 'Cliente do B', telefone: '5562900000002', codcli: null },
  ];
  const conversas = [
    { id: 10, tenant_id: '1', contato_id: 1, protocolo: '260701000010', fila_status: 'resolvida', origem: 'receptiva', criado_em: new Date() },
    { id: 20, tenant_id: '2', contato_id: 2, protocolo: '260701000020', fila_status: 'resolvida', origem: 'receptiva', criado_em: new Date() },
  ];
  const client = criarClientFalso({ conversas, contatos });
  const restaurar = comConexaoFalsa(client);
  try {
    const { server, port } = await startApp([['/api/historico', require('../api/historico')]], PERFIL_ADMIN, 1);
    try {
      const r = await get(port, '/api/historico');
      assert.equal(r.status, 200);
      const body = JSON.parse(r.body);
      assert.equal(body.total, 1);
      assert.equal(body.itens.length, 1);
      assert.equal(body.itens[0].protocolo, '260701000010');
      assert.ok(
        !body.itens.some((i) => i.protocolo === '260701000020'),
        'tenant 1 enxergou a conversa do tenant 2 — VAZAMENTO'
      );
    } finally { server.close(); }

    const { server: server2, port: port2 } = await startApp([['/api/historico', require('../api/historico')]], PERFIL_ADMIN, 2);
    try {
      const r2 = await get(port2, '/api/historico');
      const body2 = JSON.parse(r2.body);
      assert.equal(body2.total, 1);
      assert.equal(body2.itens[0].protocolo, '260701000020');
    } finally { server2.close(); }
  } finally { restaurar(); }
});
