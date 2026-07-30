// app.js — Entry do serviço (Falatta).
// Inicializa o pool Postgres, monta o webhook e o healthcheck.
// NÃO aplicamos express.json() global de propósito: o webhook precisa do
// corpo bruto (rawBodyJson) para validar a assinatura.
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');

const { loadConfig } = require('./config');
const db = require('./db/pool');
const { buildWebhookRouter } = require('./webhook/routes');

const cfg = loadConfig();
const hub = require('./realtime/hub');

const app = express();
// 2 hops confiáveis: Cloudflare (borda) → Traefik (Coolify) → Express. Cada um
// agrega seu endereço percebido ao X-Forwarded-For — com um valor menor, o
// rate limit por IP e a auditoria (operador/auditoria.js) enxergariam o IP de
// um dos proxies, não o do cliente. Não usar `true` (confia em qualquer
// X-Forwarded-For → permite spoof de IP e burla o rate-limit por IP).
app.set('trust proxy', 2);

// O frontend de produção vive em outro domínio (Vercel). CORS é restrito ao
// APP_URL e, opcionalmente, às origens adicionais de CORS_ORIGINS. Aplicado
// somente em /api: webhook e páginas públicas não precisam dele.
app.use('/api', require('./utils/corsApi').criarCorsApi({
  appUrl: process.env.APP_URL,
  corsOrigins: process.env.CORS_ORIGINS,
  nodeEnv: cfg.nodeEnv,
}));

// CSP customizada: permite a página pública (exclusão de dados) usar Google
// Fonts e estilos inline, sem afrouxar a segurança do webhook (que é JSON).
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'"],
      styleSrc:       ["'self'", "'unsafe-inline'", 'https:'],
      imgSrc:         ["'self'", 'data:', 'blob:'],  // blob: = anexos (mídia recebida)
      mediaSrc:       ["'self'", 'blob:'],            // áudio/vídeo recebidos
      connectSrc:     ["'self'"],                     // XHR/axios + EventSource (SSE)
      fontSrc:        ["'self'", 'https:', 'data:'],
      objectSrc:      ["'none'"],
      baseUri:        ["'self'"],
      frameAncestors: ["'self'"],
    },
  },
}));
// Loga sem o ticket do SSE na URL (o ticket vai na query string do /api/stream;
// 'combined' gravaria ele em claro no stdout.log). Token custom redige o ticket.
morgan.token('url-redigida', (req) => String(req.originalUrl || req.url || '').replace(/([?&]ticket=)[^&]+/i, '$1***'));
const FORMATO_PROD = ':remote-addr - :remote-user [:date[clf]] ":method :url-redigida HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"';
app.use(morgan(cfg.nodeEnv === 'production' ? FORMATO_PROD : 'dev'));

// Webhook (usa rawBodyJson internamente; não passar json global antes).
app.use('/', buildWebhookRouter(cfg));

// Páginas públicas estáticas (LGPD/Meta).
app.use(express.static(path.join(__dirname, 'public')));
app.get('/exclusao-de-dados', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'exclusao-de-dados.html'))
);

// Liveness confirma o processo; readiness também prova uma consulta real ao
// banco. O balanceador só deve enviar tráfego a uma instância ready.
app.get('/health/live', (req, res) =>
  res.json({ status: 'ok', service: 'olume-chat', ts: new Date().toISOString() })
);
async function readiness(req, res) {
  // Estado do hub SSE/LISTEN-NOTIFY (FIL-93/P0.7) — só REPORTADO, nunca gate
  // do status HTTP: o hub tem retry próprio (realtime/hub.js) e uma queda
  // transitória durante um rolling update não pode tirar uma instância
  // saudável de rotação. De propósito, sem checar a mídia guardada no bucket
  // remoto aqui — isso é diagnóstico próprio, não dependência de readiness.
  const hubStatus = hub.status();
  let conn;
  try {
    conn = await db.getConnection();
    await conn.execute('SELECT 1 AS ok');
    return res.json({ status: 'ok', service: 'olume-chat', database: 'ok', hub: hubStatus, ts: new Date().toISOString() });
  } catch (err) {
    console.error('[health] readiness falhou:', err.message);
    return res.status(503).json({ status: 'indisponivel', service: 'olume-chat', database: 'erro', hub: hubStatus });
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
}
app.get('/health/ready', readiness);
app.get('/health', readiness); // compatibilidade com monitores já configurados

// --- API REST (Fase 2 — inbox) ---
const authRoutes = require('./auth/routes');
const conversasRoutes = require('./api/conversas');
const templatesRoutes = require('./api/templates');
const midiaRoutes = require('./api/midia');
const tagsRoutes = require('./api/tags');
const streamRoutes = require('./api/stream');
const departamentosRoutes = require('./api/departamentos');
const atendentesRoutes = require('./api/atendentes');
const numerosRoutes = require('./api/numeros');
const authMiddleware = require('./auth/middleware');
const { anexarPerfil } = require('./auth/rbac');

app.use('/api', express.json({ limit: '1mb' }));
const presencaRoutes = require('./api/presenca');

app.use('/api/auth', authRoutes);
// Formulário público da landing (FIL-96) — sem autenticação de propósito;
// rate limit + honeypot próprios (ver api/leads.js).
app.use('/api/leads', require('./api/leads'));
app.use('/api/meta', authMiddleware, anexarPerfil, require('./api/meta').router);
// Painel do OPERADOR (FIL-70) — fora do RBAC de tenant: prefixo, middleware e
// sessão próprios. NÃO passa por authMiddleware/anexarPerfil de propósito;
// quem autentica é operador/middleware.js, com outro segredo de JWT.
app.use('/api/operador', require('./operador/routes'));
app.use('/api/stream', streamRoutes); // SSE: o próprio router controla a auth (ticket)
app.use('/api/conversas', authMiddleware, anexarPerfil, conversasRoutes);
app.use('/api/contatos', authMiddleware, anexarPerfil, require('./api/contatos'));
app.use('/api/presenca', authMiddleware, anexarPerfil, presencaRoutes);
app.use('/api/templates', authMiddleware, templatesRoutes);
app.use('/api/midia', authMiddleware, anexarPerfil, midiaRoutes);
app.use('/api/tags', authMiddleware, anexarPerfil, tagsRoutes);
// Administração (Fase 5A) — perfil RBAC anexado; cada rota exige o papel adequado.
app.use('/api/departamentos', authMiddleware, anexarPerfil, departamentosRoutes);
app.use('/api/atendentes', authMiddleware, anexarPerfil, atendentesRoutes);
app.use('/api/numeros', authMiddleware, anexarPerfil, numerosRoutes);
app.use('/api/fluxos', authMiddleware, anexarPerfil, require('./api/fluxos'));
app.use('/api/metricas', authMiddleware, anexarPerfil, require('./api/metricas'));
app.use('/api/historico', authMiddleware, anexarPerfil, require('./api/historico'));
app.use('/api/config', authMiddleware, anexarPerfil, require('./api/config'));
app.use('/api/campanhas', authMiddleware, anexarPerfil, require('./api/campanhas'));
app.use('/api/atalhos', authMiddleware, anexarPerfil, require('./api/atalhos'));
app.use('/api/ia-config', authMiddleware, anexarPerfil, require('./api/iaConfig'));
app.use('/api/ia-autorizados', authMiddleware, anexarPerfil, require('./api/iaAutorizados'));
// FIL-83: instruções, ficha e base de conhecimento da IA por empresa — o
// system prompt do bot passa a sair daqui (ver ia/perfilStore.js), não mais de
// um arquivo em disco global para o processo.
app.use('/api/ia-perfil', authMiddleware, anexarPerfil, require('./api/iaPerfil').perfil);
app.use('/api/ia-conhecimento', authMiddleware, anexarPerfil, require('./api/iaPerfil').conhecimento);
// FIL-85: o que a IA PODE FAZER nesta empresa (liga/desliga + formulário de
// pedido) e a tela de conferência dos pedidos que ela registrou.
app.use('/api/ia-ferramentas', authMiddleware, anexarPerfil, require('./api/iaFerramentas'));
app.use('/api/ia-pedidos', authMiddleware, anexarPerfil, require('./api/iaPedidos'));
app.use('/api/onboarding-meta', authMiddleware, anexarPerfil, require('./api/onboardingMeta'));

// --- SPA (frontend) em produção, se o build do client existir ---
if (cfg.nodeEnv === 'production') {
  const distPath = path.join(__dirname, '..', 'client', 'dist');
  if (fs.existsSync(distPath)) {
    // Assets com hash no nome (index-ABC123.js) = imutáveis (cache longo).
    // index.html = SEMPRE revalida (no-cache) — senão o navegador serve um HTML
    // antigo apontando pro JS antigo e a atualização "não aparece" sem hard-refresh.
    app.use(express.static(distPath, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (/\.(?:js|css|woff2?|png|jpe?g|svg|webp|ico)$/i.test(filePath)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/webhook')
          || req.path.startsWith('/health') || req.path === '/exclusao-de-dados') return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }
}

app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

// Error handler JSON — sempre o último. Devolver a mensagem real do banco
// acelera MUITO o diagnóstico — antes o "Erro interno" seco obrigava a ir
// atrás do stderr.log do serviço.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[api] erro:', err.message);
  // Erros de INFRA/REDE embutem host:porta do banco na mensagem — nunca
  // devolver isso ao cliente. Classe 08 = falha de conexão, 57P0x = servidor
  // indisponível, EC*/ETIMEDOUT = socket. Erros de DADOS (violação de
  // constraint, tipo, etc.) seguem como mensagem real.
  const msg = String(err.message || '');
  const code = String(err.code || '');
  if (/^(08|57P0)/.test(code) || /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)$/.test(code)) {
    return res.status(503).json({ error: 'Banco de dados indisponível. Tente novamente em instantes.' });
  }
  res.status(500).json({ error: 'Erro interno: ' + (msg || 'desconhecido') });
});

// Versão do app (mesma do instalador) para a telemetria do Pulso.
function versaoApp() {
  try {
    return require('fs').readFileSync(require('path').join(__dirname, '..', 'installer', 'VERSION'), 'utf8').trim();
  } catch {
    return process.env.PULSO_APP_VERSION || 'dev';
  }
}

async function start() {
  try {
    await db.initPool();
    // Aguarda a tentativa inicial de conexão do hub antes de aceitar tráfego
    // (FIL-93/P0.7): não bloqueia se DATABASE_URL_DIRECT estiver ausente
    // (hub.start() resolve rápido nesse caso) nem se a conexão falhar (o hub
    // já agenda retry sozinho) — só garante que /health/ready não reporte um
    // estado que o processo nem tentou alcançar ainda.
    await hub.start();
    // Recuperação pós-restart: redistribui conversas que ficaram aguardando.
    require('./fila/distribuidor').varrerPendentes();
    // FIL-94: eventos do webhook aceitos e não concluídos (processo morto no
    // meio) voltam ao trilho; também mede pendência/atraso e aplica a retenção
    // do log bruto. Ver webhook/durabilidade.js.
    require('./webhook/durabilidade').iniciar();
    // Timeout de inatividade do bot (autoatendimento).
    require('./bot/sweeper').iniciar();
    // Dispatcher de campanha de cobrança em lote.
    require('./campanha/dispatcher').iniciar();
    // Fechamento mensal + retenção de consumo (FIL-77).
    require('./consumo/fechamento').iniciar();
    // financeiro: geração mensal de fatura + marcação de atrasadas (FIL-79).
    require('./financeiro/faturamento').iniciar();
    // Telemetria/licença (Pulso) — opcional: sem PULSO_* no .env fica inerte
    // (não derruba o app). Capturado (não descartado) porque tem estado
    // próprio de módulo (timer) — chamar iniciar() de novo no shutdown pra
    // conseguir o parar() vazaria um segundo timer por cima do primeiro.
    const pulso = require('./telemetria/pulso-agent').iniciar({
      app: 'mc-atendimentos',
      versao: versaoApp(),
      online: () => require('./realtime/presence').snapshot().filter((p) => p.estado === 'online').length,
    });
    const server = app.listen(cfg.port, () => {
      console.log(`[mc-zap] Rodando na porta ${cfg.port} — ${cfg.nodeEnv}`);
    });

    // FIL-93 (P0.7): shutdown gracioso com prazo máximo. server.close() só
    // chama seu callback quando TODA conexão HTTP existente termina — uma SSE
    // fica aberta indefinidamente, então sem fechar essas conexões (e sem um
    // deadline) o processo travaria no SIGTERM em vez de sair limpo.
    function shutdown() {
      console.log('[mc-zap] Encerrando...');
      const prazoMs = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 10_000;
      const forcar = setTimeout(() => {
        console.error(`[mc-zap] Encerramento excedeu ${prazoMs}ms — saindo à força.`);
        process.exit(1);
      }, prazoMs);

      // Para timers periódicos primeiro (não abrem transação nova depois
      // daqui) e fecha as conexões SSE (senão prendem server.close()).
      require('./bot/sweeper').parar();
      require('./campanha/dispatcher').parar();
      require('./consumo/fechamento').parar();
      require('./financeiro/faturamento').parar();
      pulso.parar();
      require('./api/stream').encerrarTodas();

      server.close(async () => {
        try {
          await hub.stop();
          await db.closePool();
        } finally {
          clearTimeout(forcar);
          process.exit(0);
        }
      });
    }
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (err) {
    console.error('[mc-zap] Falha ao iniciar:', err);
    process.exit(1);
  }
}

start();
