// db/pool.js — Pool node-oracledb thick mode (padrão web MC).
// Thick mode é obrigatório por causa do verifier antigo (0x939) do MCCANAL.
const oracledb = require('oracledb');

oracledb.outFormat     = oracledb.OUT_FORMAT_OBJECT;
oracledb.fetchAsString = [oracledb.CLOB];

let pool;
let clientInitialized = false;

// Init do Oracle Client (thick mode) sob demanda — NÃO no require, para o
// módulo poder ser importado em testes sem o Instant Client instalado.
function initClient() {
  if (clientInitialized) return;
  const clientOpts = {};
  if (process.env.ORACLE_LIB_DIR) clientOpts.libDir = process.env.ORACLE_LIB_DIR;
  oracledb.initOracleClient(clientOpts);
  clientInitialized = true;
}

async function initPool() {
  initClient();
  pool = await oracledb.createPool({
    user:          process.env.ORACLE_USER,
    password:      process.env.ORACLE_PASSWORD,
    connectString: process.env.ORACLE_CONNECT_STRING,
    poolMin:       2,
    poolMax:       Number(process.env.ORACLE_POOL_MAX) || 20, // headroom (era 10) — ajustável por env
    poolIncrement: 2,
    poolTimeout:   60,
    // poolPingInterval: testa a conexão ociosa antes de entregar — derruba/renova
    // conexão morta (blip de rede ao ERP) que ficaria "presa". Sem isso, conexões
    // mortas contam contra o poolMax e ajudam a estourar (NJS-040).
    poolPingInterval: 60,
    queueTimeout:  30_000,  // falha em 30s em vez de esperar indefinidamente na fila
    queueMax:      500,     // teto da fila de espera (shed load em pico)
    stmtCacheSize: 30,
  });
  console.log('[db] Pool Oracle inicializado');
}

async function getConnection() {
  return pool.getConnection();
}

async function closePool() {
  if (pool) await pool.close(10);
}

module.exports = { initPool, getConnection, closePool, oracledb };
