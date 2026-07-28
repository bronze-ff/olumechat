'use strict';

// Os testes legados de Graph usam o mock do token global. Isso é habilitado
// somente neste processo de teste; o servidor nunca liga o fallback sozinho.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const env = { ...process.env, DEV_META_FALLBACK: process.env.DEV_META_FALLBACK || '1' };
const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).map((f) => path.join(__dirname, f));
// Muitos testes substituem o singleton de banco por implementações em memória.
// Rodá-los em paralelo faz um arquivo sobrescrever o mock de outro e gera
// falhas espúrias; a aplicação continua concorrente, mas a suíte é serial.
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit', env });
process.exit(r.status == null ? 1 : r.status);
