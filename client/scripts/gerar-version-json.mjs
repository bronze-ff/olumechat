// Gera `dist/version.json` — o marcador da build do frontend (FIL-113).
//
// Roda no estágio de build do `client/Dockerfile`, depois do `npm run build`,
// com `OLUME_COMMIT_SHA` vindo de `--build-arg`. O arquivo resultante fica
// dentro da imagem, servido pelo Nginx em `/version.json`.
//
// O objeto é IDÊNTICO ao campo `versao` das respostas de `/health/*` da API
// (`server/versao.js`) de propósito: quem verifica um deploy — o smoke de
// staging hoje, o FIL-101 em produção depois — lê a mesma forma nos dois lados,
// sem dois contratos para manter. São duas implementações porque são dois
// runtimes (CommonJS no server, ESM no build do Vite); que elas não divirjam é
// provado por teste (`server/test/versao.test.js`), não por combinado.
//
//   { "sha": "<40 hex>", "curto": "<7 hex>", "tag": "sha-<7 hex>", "origem": "build" }
//   { "sha": null, "curto": null, "tag": null, "origem": "desconhecida" }
//
// Sem SHA (build local) o arquivo sai como `desconhecida`, nunca com um palpite:
// quem verifica precisa distinguir "esta build não sabe quem é" de "esta build
// é a que você deployou". Quem EXIGE o marcador é a CI (job `frontend-image`),
// que sobe as duas imagens e reprova se `/version.json` não trouxer o commit.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, env } from 'node:process';
import { pathToFileURL } from 'node:url';

// SHA de commit: hexadecimal minúsculo, do curto (7) ao completo (40).
export const RE_SHA = /^[0-9a-f]{7,40}$/;

// Valor que não se parece com um SHA não vira marcador parcial: vira
// `desconhecida`. Meia-verdade aqui seria pior que silêncio, porque o
// verificador compararia lixo com lixo e poderia casar.
export function derivar(bruto) {
  const sha = String(bruto ?? '').trim().toLowerCase();
  if (!RE_SHA.test(sha)) return { sha: null, curto: null, tag: null, origem: 'desconhecida' };
  const curto = sha.slice(0, 7);
  return { sha, curto, tag: `sha-${curto}`, origem: 'build' };
}

export function gerar(destino, bruto) {
  const versao = derivar(bruto);
  const caminho = resolve(destino);
  writeFileSync(caminho, `${JSON.stringify(versao)}\n`);
  return { caminho, versao };
}

// Só escreve quando chamado direto pelo Dockerfile — importar este arquivo (o
// teste de contrato faz isso) não pode gerar arquivo nenhum.
// Sem `process.exit()` aqui de propósito: com stdout num pipe (é o caso dentro
// do `docker build`), sair antes do flush trunca a última linha — e a linha
// truncada seria justamente a que diz qual versão foi gravada.
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  const { caminho, versao } = gerar(argv[2] ?? 'dist/version.json', env.OLUME_COMMIT_SHA);
  console.log(`[versao] ${caminho}: ${versao.origem}${versao.sha ? ` ${versao.sha}` : ''}`);
}
