// scripts/carga/amostrar.js — Amostragem de CPU/RAM do processo alvo (FIL-110).
//
// O harness NÃO instrumenta o produto: nenhuma rota nova, nenhuma métrica
// exportada só para o teste. A amostragem é externa, pelo sistema operacional,
// contra o PID informado em `--pid`.
//
// Onde rodar para cada ambiente:
//   local   — `--pid <pid do node app.js>`
//   staging — rodar o harness DE DENTRO do container (`docker exec`), com
//             `--pid 1`: o backend é o PID 1 da imagem.
//
// Sem `--pid`, os cenários rodam mesmo assim e o relatório registra
// "não medido" em CPU/RAM — número inventado é pior que lacuna declarada.
'use strict';

const fs = require('node:fs');
const { execFile } = require('node:child_process');

/** Lê RSS (bytes) e tempo de CPU acumulado (ms) do PID. `null` se indisponível. */
async function amostra(pid) {
  if (!pid) return null;
  try {
    if (process.platform === 'linux') return amostraLinux(pid);
    if (process.platform === 'win32') return await amostraWindows(pid);
    return await amostraPs(pid);
  } catch {
    return null;
  }
}

function amostraLinux(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  // O nome do processo vem entre parênteses e pode conter espaços: corta pelo
  // ÚLTIMO ')' antes de separar os campos, senão os índices saem deslocados.
  const campos = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const utime = Number(campos[11]);   // campo 14 do proc(5)
  const stime = Number(campos[12]);   // campo 15
  const rssPaginas = Number(campos[21]); // campo 24
  const hz = 100; // USER_HZ em praticamente todo Linux x86_64
  return {
    rssBytes: rssPaginas * 4096,
    cpuMs: ((utime + stime) / hz) * 1000,
    fonte: '/proc',
  };
}

function amostraWindows(pid) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-Process -Id ${Number(pid)} -ErrorAction Stop; ` +
      '"{0} {1}" -f $p.WorkingSet64, $p.TotalProcessorTime.TotalMilliseconds',
    ], (err, saida) => {
      if (err) return reject(err);
      const [rss, cpu] = String(saida).trim().split(/\s+/);
      resolve({ rssBytes: Number(rss), cpuMs: Number(String(cpu).replace(',', '.')), fonte: 'Get-Process' });
    });
  });
}

function amostraPs(pid) {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-o', 'rss=,time=', '-p', String(Number(pid))], (err, saida) => {
      if (err) return reject(err);
      const [rssKb, tempo] = String(saida).trim().split(/\s+/);
      const partes = String(tempo).split(':').map(Number).reverse(); // ss, mm, hh
      const seg = (partes[0] || 0) + (partes[1] || 0) * 60 + (partes[2] || 0) * 3600;
      resolve({ rssBytes: Number(rssKb) * 1024, cpuMs: seg * 1000, fonte: 'ps' });
    });
  });
}

/**
 * CPU% entre duas amostras: tempo de CPU consumido / tempo de parede decorrido.
 * 100% = um núcleo saturado (pode passar de 100 em processo multi-thread).
 */
function cpuPercentual(anterior, atual, msDecorridos) {
  if (!anterior || !atual || !msDecorridos) return null;
  return ((atual.cpuMs - anterior.cpuMs) / msDecorridos) * 100;
}

module.exports = { amostra, cpuPercentual };
