// versao.js — o marcador da build que ESTE processo está servindo (FIL-113).
//
// POR QUE EXISTE. Até aqui nenhuma resposta do backend dizia qual build
// respondeu. `200 OK` é perfeitamente compatível com "container VELHO e
// saudável" — foi exatamente o que aconteceu em 2026-07-31, quando dois
// containers disputavam o mesmo `Host()` do Traefik: o deploy terminou verde, o
// `/health` respondia 200 e o mundo recebeu a versão anterior por horas
// (docs/AMBIENTES.md). Para o smoke de deploy poder FALHAR nesse caso, a
// resposta precisa carregar a versão servida.
//
// DE ONDE VEM O VALOR. De um arquivo gravado DENTRO da imagem em tempo de build
// (o `Dockerfile` recebe `--build-arg OLUME_COMMIT_SHA` e escreve `/app/BUILD_SHA`).
// Deliberadamente NÃO de variável de ambiente, e a diferença não é estética:
//
//   - variável de ambiente é CONFIGURAÇÃO. No Coolify ela é editável e, quando
//     uma aplicação é recriada, copiada à mão de uma para outra — o
//     procedimento está escrito em docs/AMBIENTES.md. Um valor arrastado junto
//     passaria a AFIRMAR uma versão que a imagem não tem, e marcador que pode
//     mentir é pior que marcador nenhum: o smoke passa a confiar nele;
//   - o arquivo é produzido pelo MESMO build que produziu o código. É evidência,
//     não intenção — a mesma distinção que a guarda do `deploy-staging.yml` já
//     faz entre `docker_registry_image_tag` (intenção) e o histórico de
//     deployments (evidência).
//
// Por isso este módulo não lê `process.env` em lugar nenhum: não há como
// declarar uma versão por fora do build.
//
// AUSÊNCIA É REPORTADA COMO AUSÊNCIA. Sem o arquivo (build local, ou imagem
// anterior ao FIL-113), o resultado é `origem: 'desconhecida'` com os campos
// nulos — nunca um palpite. Quem consome DEVE tratar isso como falha: "não sei
// que versão sou" é precisamente o caso do container velho ainda atendendo.
//
// CONTRATO DA RESPOSTA (estável — o FIL-101 vai consumi-lo para promover
// produção; o mesmo objeto é servido pelo frontend em `/version.json`):
//
//   { "sha": "<40 hex>", "curto": "<7 hex>", "tag": "sha-<7 hex>", "origem": "build" }
//   { "sha": null, "curto": null, "tag": null, "origem": "desconhecida" }
//
// `tag` é exatamente a tag da imagem no GHCR, para o verificador comparar sem
// derivar nada.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// SHA de commit: hexadecimal minúsculo, do curto (7) ao completo (40).
const RE_SHA = /^[0-9a-f]{7,40}$/;

// Fora de `WORKDIR` (/app/server) de propósito: `COPY server/ ./` sobrescreve
// aquele diretório inteiro, então um arquivo gerado lá dentro dependeria da
// ordem das camadas para sobreviver.
const ARQUIVO_PADRAO = path.join(__dirname, '..', 'BUILD_SHA');

const DESCONHECIDA = Object.freeze({ sha: null, curto: null, tag: null, origem: 'desconhecida' });

// Deriva o marcador a partir do SHA cru. Valor que não se parece com um SHA não
// vira marcador parcial: vira `desconhecida`. Meia-verdade aqui seria pior que
// silêncio, porque o smoke compararia lixo com lixo e poderia casar.
function derivar(bruto) {
  const sha = String(bruto ?? '').trim().toLowerCase();
  if (!RE_SHA.test(sha)) return DESCONHECIDA;
  const curto = sha.slice(0, 7);
  return Object.freeze({ sha, curto, tag: `sha-${curto}`, origem: 'build' });
}

function lerArquivo(arquivo = ARQUIVO_PADRAO) {
  try {
    return derivar(fs.readFileSync(arquivo, 'utf8'));
  } catch {
    // Ausente ou ilegível — em desenvolvimento é o caso normal.
    return DESCONHECIDA;
  }
}

// Lido UMA vez, no boot: o arquivo é imutável dentro da imagem, e o HEALTHCHECK
// do Dockerfile bate em /health/ready de 30 em 30 segundos — reler ali seria I/O
// por requisição sem nenhum ganho de verdade.
const versao = lerArquivo();

module.exports = { versao, lerArquivo, derivar, ARQUIVO_PADRAO, RE_SHA };
