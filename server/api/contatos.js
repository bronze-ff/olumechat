// api/contatos.js — Ficha do contato: identificação interna + vínculo com o
// sistema do tenant (seam clienteLookup).
//
// O contato chega com o NOME_PERFIL do WhatsApp (ex.: "somente wattzap"). Aqui a
// gente grava NO CONTATO (vale para todas as conversas daquele telefone): nome
// interno/apelido, documento (CPF/CNPJ), vínculo com o código externo do tenant,
// observações e tags. CODIGO_EXTERNO/DOCUMENTO eram CODCLI/CGCENT do ERP WinThor
// do fork original — generalizados (ver docs/PORTE.md "Resíduo conhecido" e a
// migração 002).
'use strict';

const express = require('express');
const db = require('../db/pool');
const { exigirPapel } = require('../auth/rbac');
const { acharClientePorTelefone, dadosClienteWinthor } = require('../utils/clienteLookup');
const { publish } = require('../realtime/hub');

const router = express.Router();

/** Bloqueia AUDITOR (somente-leitura) nas mutações. */
function naoAuditor(req, res, next) {
  if (req.perfil && req.perfil.papel === 'AUDITOR') {
    return res.status(403).json({ error: 'Perfil somente-leitura (AUDITOR) não pode executar esta ação.' });
  }
  next();
}

/**
 * Escopo do contato: gestores/AUDITOR veem todos; os demais só veem um contato se
 * tiverem ao menos UMA conversa dele dentro do próprio escopo (mesma regra da
 * lista de conversas). Devolve a linha do contato ou null (404).
 */
async function contatoNoEscopo(conn, id, perfil) {
  const r = await conn.execute(
    `SELECT ct.id, ct.telefone, ct.nome_perfil, ct.nome_interno, ct.codigo_externo, ct.documento,
            ct.nome_completo, ct.razao_social, ct.nome_fantasia, ct.email,
            ct.telefone_alternativo, ct.cep, ct.logradouro, ct.numero_endereco,
            ct.complemento, ct.bairro, ct.cidade, ct.uf,
            COALESCE((
              SELECT jsonb_agg(
                       jsonb_build_object(
                         'departamentoId', cad.departamento_id,
                         'departamentoNome', dep.nome,
                         'atendenteId', cad.atendente_id,
                         'atendenteNome', resp.nome
                       )
                       ORDER BY dep.nome
                     )
                FROM contato_atendente_depto cad
                JOIN departamento dep ON dep.id = cad.departamento_id
                JOIN atendente resp ON resp.id = cad.atendente_id
               WHERE cad.contato_id = ct.id
            ), '[]'::jsonb) AS vinculos_atendimento,
            ct.observacoes, ct.tags_contato, ct.atualizado_em, ct.criado_em,
            a.nome AS atualizado_por_nome
       FROM contato ct
       LEFT JOIN atendente a ON a.tenant_id = ct.tenant_id AND a.id = ct.atualizado_por
      WHERE ct.id = :id`,
    { id }
  );
  if (!r.rows.length) return null;
  if (!perfil || ['ADMIN', 'SUPERVISOR', 'AUDITOR'].includes(perfil.papel)) return r.rows[0];

  // Existe alguma conversa deste contato no escopo do atendente?
  const binds = { id };
  const partes = ['c.departamento_id IS NULL'];
  if (perfil.atendenteId) { partes.push('c.atendente_id = :atd'); binds.atd = perfil.atendenteId; }
  (perfil.deptoIds || []).forEach((d, i) => { binds['d' + i] = d; });
  if ((perfil.deptoIds || []).length) {
    partes.push(`c.departamento_id IN (${perfil.deptoIds.map((_, i) => ':d' + i).join(',')})`);
  }
  let numFiltro = '';
  if ((perfil.numeroIds || []).length) {
    perfil.numeroIds.forEach((n, i) => { binds['n' + i] = n; });
    const ns = perfil.numeroIds.map((_, i) => ':n' + i).join(',');
    numFiltro = ` AND (c.numero_id IS NULL OR c.numero_id IN (${ns})${perfil.atendenteId ? ' OR c.atendente_id = :atd' : ''})`;
  }
  const ok = await conn.execute(
    `SELECT 1 FROM conversa c
      WHERE c.contato_id = :id AND (${partes.join(' OR ')})${numFiltro}
      FETCH FIRST 1 ROWS ONLY`,
    binds
  );
  return ok.rows.length ? r.rows[0] : null;
}

function montarFicha(row) {
  const vinculos = typeof row.VINCULOS_ATENDIMENTO === 'string'
    ? JSON.parse(row.VINCULOS_ATENDIMENTO)
    : (row.VINCULOS_ATENDIMENTO || []);
  return {
    id: row.ID,
    telefone: row.TELEFONE,
    nomePerfil: row.NOME_PERFIL,
    nomeInterno: row.NOME_INTERNO,
    nomeCompleto: row.NOME_COMPLETO || null,
    razaoSocial: row.RAZAO_SOCIAL || null,
    nomeFantasia: row.NOME_FANTASIA || null,
    email: row.EMAIL || null,
    telefoneAlternativo: row.TELEFONE_ALTERNATIVO || null,
    codigoExterno: row.CODIGO_EXTERNO || null,
    documento: row.DOCUMENTO || null,
    endereco: {
      cep: row.CEP || null,
      logradouro: row.LOGRADOURO || null,
      numero: row.NUMERO_ENDERECO || null,
      complemento: row.COMPLEMENTO || null,
      bairro: row.BAIRRO || null,
      cidade: row.CIDADE || null,
      uf: row.UF || null,
    },
    vinculosAtendimento: Array.isArray(vinculos) ? vinculos : [],
    observacoes: row.OBSERVACOES,
    // jsonb já chega decodificado pelo driver `pg` (ver db/pool.js) — só faz
    // parse se, por algum motivo, ainda vier como string (defensivo).
    tags: typeof row.TAGS_CONTATO === 'string' ? JSON.parse(row.TAGS_CONTATO) : (row.TAGS_CONTATO || []),
    atualizadoPor: row.ATUALIZADO_POR_NOME || null,
    atualizadoEm: row.ATUALIZADO_EM || null,
    criadoEm: row.CRIADO_EM || null,
    conversas: Number(row.CONVERSAS || 0),
    ultimaInteracao: row.ULTIMA_INTERACAO || null,
  };
}

function textoOpcional(valor, limite) {
  if (valor == null) return null;
  return String(valor).trim().slice(0, limite) || null;
}

function telefoneValido(valor, obrigatorio = false) {
  const telefone = String(valor || '').replace(/\D/g, '').slice(0, 20);
  if (!telefone && !obrigatorio) return null;
  if (telefone.length < 8) return undefined;
  return telefone;
}

function dadosDaFicha(body) {
  const b = body || {};
  const endereco = b.endereco || {};
  const email = textoOpcional(b.email, 254);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { erro: 'Informe um e-mail válido.' };
  }
  const uf = textoOpcional(endereco.uf ?? b.uf, 2);
  return {
    nomeInterno: textoOpcional(b.nomeInterno, 200),
    nomeCompleto: textoOpcional(b.nomeCompleto, 200),
    razaoSocial: textoOpcional(b.razaoSocial, 200),
    nomeFantasia: textoOpcional(b.nomeFantasia, 200),
    documento: b.documento != null ? String(b.documento).replace(/\D/g, '').slice(0, 20) || null : null,
    email,
    telefoneAlternativo: telefoneValido(b.telefoneAlternativo),
    cep: b.cep != null || endereco.cep != null
      ? String(endereco.cep ?? b.cep).replace(/\D/g, '').slice(0, 9) || null
      : null,
    logradouro: textoOpcional(endereco.logradouro ?? b.logradouro, 200),
    numeroEndereco: textoOpcional(endereco.numero ?? b.numeroEndereco, 30),
    complemento: textoOpcional(endereco.complemento ?? b.complemento, 100),
    bairro: textoOpcional(endereco.bairro ?? b.bairro, 100),
    cidade: textoOpcional(endereco.cidade ?? b.cidade, 100),
    uf: uf ? uf.toUpperCase() : null,
    observacoes: textoOpcional(b.observacoes, 2000),
  };
}

function erroValidacao(mensagem) {
  const erro = new Error(mensagem);
  erro.status = 400;
  return erro;
}

async function validarVinculosAtendimento(conn, valor) {
  if (valor == null) return [];
  if (!Array.isArray(valor)) {
    throw erroValidacao('Os responsáveis por departamento devem ser enviados em uma lista.');
  }

  const saida = [];
  const departamentos = new Set();
  for (const item of valor) {
    const departamentoId = Number(item && item.departamentoId);
    const atendenteId = Number(item && item.atendenteId);
    if (!Number.isInteger(departamentoId) || !Number.isInteger(atendenteId)) {
      throw erroValidacao('Selecione um departamento e um atendente válidos em cada vínculo.');
    }
    if (departamentos.has(departamentoId)) {
      throw erroValidacao('Cada departamento pode ter somente um atendente responsável por cliente.');
    }

    const valido = await conn.execute(
      `SELECT ad.atendente_id
         FROM atendente_depto ad
         JOIN atendente a ON a.id = ad.atendente_id AND a.ativo = 'S'
         JOIN departamento d ON d.id = ad.departamento_id AND d.ativo = 'S'
        WHERE ad.departamento_id = :d AND ad.atendente_id = :a`,
      { d: departamentoId, a: atendenteId }
    );
    if (!valido.rows.length) {
      throw erroValidacao('O atendente escolhido precisa estar ativo e pertencer ao departamento selecionado.');
    }
    departamentos.add(departamentoId);
    saida.push({ departamentoId, atendenteId });
  }
  return saida;
}

async function salvarVinculosAtendimento(conn, contatoId, vinculos, editor) {
  await conn.execute(
    `DELETE FROM contato_atendente_depto WHERE contato_id = :id`,
    { id: contatoId }
  );
  for (const vinculo of vinculos) {
    await conn.execute(
      `INSERT INTO contato_atendente_depto
         (contato_id, departamento_id, atendente_id, criado_por, atualizado_em)
       VALUES (:ct, :d, :a, :editor, now())`,
      {
        ct: contatoId,
        d: vinculo.departamentoId,
        a: vinculo.atendenteId,
        editor,
      }
    );
  }
}

// GET /api/contatos — carteira completa usada pela área Clientes da gestão.
router.get('/', exigirPapel('ADMIN', 'SUPERVISOR', 'AUDITOR'), async (req, res, next) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  const pagina = Math.max(1, Number(req.query.pagina) || 1);
  const limite = Math.min(100, Math.max(10, Number(req.query.limite) || 30));
  try {
    const resultado = await db.comTenant(req.tenantId, async (conn) => {
      const buscaBinds = q ? { q: `%${q}%` } : {};
      const binds = {
        ...buscaBinds,
        limite,
        offset: (pagina - 1) * limite,
      };
      const filtro = q
        ? `WHERE COALESCE(ct.nome_interno, '') ILIKE :q
              OR COALESCE(ct.nome_completo, '') ILIKE :q
              OR COALESCE(ct.nome_perfil, '') ILIKE :q
              OR COALESCE(ct.razao_social, '') ILIKE :q
              OR COALESCE(ct.nome_fantasia, '') ILIKE :q
              OR COALESCE(ct.documento, '') ILIKE :q
              OR COALESCE(ct.email, '') ILIKE :q
              OR ct.telefone ILIKE :q`
        : '';
      const lista = await conn.execute(
        `SELECT ct.id, ct.telefone, ct.nome_perfil, ct.nome_interno, ct.codigo_externo, ct.documento,
                ct.nome_completo, ct.razao_social, ct.nome_fantasia, ct.email,
                ct.telefone_alternativo, ct.cep, ct.logradouro, ct.numero_endereco,
                ct.complemento, ct.bairro, ct.cidade, ct.uf,
                COALESCE((
                  SELECT jsonb_agg(
                           jsonb_build_object(
                             'departamentoId', cad.departamento_id,
                             'departamentoNome', dep.nome,
                             'atendenteId', cad.atendente_id,
                             'atendenteNome', resp.nome
                           )
                           ORDER BY dep.nome
                         )
                    FROM contato_atendente_depto cad
                    JOIN departamento dep ON dep.id = cad.departamento_id
                    JOIN atendente resp ON resp.id = cad.atendente_id
                   WHERE cad.contato_id = ct.id
                ), '[]'::jsonb) AS vinculos_atendimento,
                ct.observacoes, ct.tags_contato, ct.atualizado_em, ct.criado_em,
                editor.nome AS atualizado_por_nome,
                atividade.conversas, atividade.ultima_interacao
           FROM contato ct
           LEFT JOIN atendente editor
             ON editor.tenant_id = ct.tenant_id AND editor.id = ct.atualizado_por
           LEFT JOIN LATERAL (
             SELECT COUNT(*) AS conversas, MAX(c.ultima_msg_em) AS ultima_interacao
               FROM conversa c
              WHERE c.contato_id = ct.id
           ) atividade ON true
           ${filtro}
          ORDER BY atividade.ultima_interacao DESC NULLS LAST,
                   COALESCE(ct.nome_interno, ct.nome_completo, ct.nome_perfil, ct.telefone)
          LIMIT :limite OFFSET :offset`,
        binds
      );
      const total = await conn.execute(
        `SELECT COUNT(*) AS qtd FROM contato ct ${filtro}`,
        buscaBinds
      );
      return {
        itens: lista.rows.map(montarFicha),
        total: Number(total.rows[0].QTD || 0),
        pagina,
        limite,
      };
    });
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// GET /api/contatos/historico — busca apenas contatos já atendidos pela própria
// pessoa. É a fonte do seletor "Nova conversa"; não expõe a carteira inteira.
router.get('/historico', async (req, res, next) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  const atendenteId = req.perfil && req.perfil.atendenteId;
  if (!atendenteId) return res.json([]);
  try {
    const itens = await db.comTenant(req.tenantId, async (conn) => {
      const binds = { atd: atendenteId, ...(q ? { q: `%${q}%` } : {}) };
      const filtro = q
        ? `AND (COALESCE(ct.nome_interno, '') ILIKE :q
               OR COALESCE(ct.nome_completo, '') ILIKE :q
               OR COALESCE(ct.nome_perfil, '') ILIKE :q
               OR ct.telefone ILIKE :q)`
        : '';
      const r = await conn.execute(
        `SELECT ct.id, ct.telefone, ct.nome_perfil, ct.nome_interno, ct.nome_completo,
                MAX(c.ultima_msg_em) AS ultima_interacao
           FROM contato ct
           JOIN conversa c ON c.contato_id = ct.id
          WHERE c.atendente_id = :atd ${filtro}
          GROUP BY ct.id, ct.telefone, ct.nome_perfil, ct.nome_interno, ct.nome_completo
          ORDER BY ultima_interacao DESC NULLS LAST
          FETCH FIRST 20 ROWS ONLY`,
        binds
      );
      return r.rows.map((row) => ({
        id: row.ID,
        telefone: row.TELEFONE,
        nome: row.NOME_INTERNO || row.NOME_COMPLETO || row.NOME_PERFIL || row.TELEFONE,
        ultimaInteracao: row.ULTIMA_INTERACAO || null,
      }));
    });
    res.json(itens);
  } catch (err) {
    next(err);
  }
});

// POST /api/contatos — cria uma ficha antes do primeiro atendimento ativo.
router.post('/', exigirPapel('ADMIN', 'SUPERVISOR'), async (req, res, next) => {
  const telefone = telefoneValido(req.body && req.body.telefone, true);
  if (telefone === undefined) return res.status(400).json({ error: 'Informe um telefone válido com DDD.' });
  const ficha = dadosDaFicha(req.body);
  if (ficha.erro) return res.status(400).json({ error: ficha.erro });
  if (ficha.telefoneAlternativo === undefined) {
    return res.status(400).json({ error: 'Informe um telefone alternativo válido.' });
  }
  try {
    const id = await db.comTenant(req.tenantId, async (conn) => {
      const vinculos = await validarVinculosAtendimento(conn, req.body.vinculosAtendimento);
      const ins = await conn.execute(
        `INSERT INTO contato (
           telefone, nome_interno, nome_completo, razao_social, nome_fantasia,
           documento, email, telefone_alternativo, cep, logradouro, numero_endereco,
           complemento, bairro, cidade, uf, observacoes, atualizado_por, atualizado_em
         ) VALUES (
           :tel, :ni, :nc, :rs, :nf, :doc, :email, :ta, :cep, :log, :num,
           :comp, :bairro, :cidade, :uf, :obs, :editor, now()
         ) RETURNING id`,
        {
          tel: telefone, ni: ficha.nomeInterno, nc: ficha.nomeCompleto,
          rs: ficha.razaoSocial, nf: ficha.nomeFantasia, doc: ficha.documento,
          email: ficha.email, ta: ficha.telefoneAlternativo, cep: ficha.cep,
          log: ficha.logradouro, num: ficha.numeroEndereco, comp: ficha.complemento,
          bairro: ficha.bairro, cidade: ficha.cidade, uf: ficha.uf,
          obs: ficha.observacoes,
          editor: req.perfil && req.perfil.atendenteId,
        }
      );
      const contatoId = ins.rows[0].ID;
      await salvarVinculosAtendimento(
        conn,
        contatoId,
        vinculos,
        req.perfil && req.perfil.atendenteId
      );
      return contatoId;
    });
    publish({ tipo: 'contato', contatoId: id, tenantId: req.tenantId });
    res.status(201).json({ id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe um cliente com este telefone.' });
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// GET /api/contatos/:id — ficha do contato. Se ainda não tem CODIGO_EXTERNO,
// tenta uma SUGESTÃO de cliente pelo telefone (pra identificar contatos antigos
// sem mexer).
router.get('/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const ficha = await db.comTenant(req.tenantId, async (conn) => {
      const row = await contatoNoEscopo(conn, id, req.perfil);
      if (!row) return null;
      const f = montarFicha(row);
      if (f.codigoExterno) {
        // Dados do cliente no sistema do tenant (vendedor/supervisor/telefones) — best-effort.
        f.dadosExternos = await dadosClienteWinthor(conn, f.codigoExterno);
      } else {
        const sug = await acharClientePorTelefone(conn, row.TELEFONE);
        if (sug) f.sugestao = { codigoExterno: sug.codigo, nome: sug.nome, documento: sug.documento };
      }
      return f;
    });
    if (!ficha) return res.status(404).json({ error: 'Contato não encontrado' });
    res.json(ficha);
  } catch (err) {
    next(err);
  }
});

// PUT /api/contatos/:id — salva somente os campos enviados; valores vazios
// limpam o campo. Telefone principal e responsáveis por departamento são decisões de
// gestão, enquanto os demais dados continuam editáveis no contexto do inbox.
router.put('/:id', naoAuditor, async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  const b = req.body || {};
  const ficha = dadosDaFicha(b);
  if (ficha.erro) return res.status(400).json({ error: ficha.erro });
  const codigoExterno = b.codigoExterno != null && b.codigoExterno !== '' ? Number(b.codigoExterno) : null;
  if (codigoExterno != null && !Number.isInteger(codigoExterno)) return res.status(400).json({ error: 'codigoExterno inválido' });
  const tem = (obj, campo) => Object.prototype.hasOwnProperty.call(obj, campo);
  const endereco = b.endereco || {};
  const gestor = req.perfil && ['ADMIN', 'SUPERVISOR'].includes(req.perfil.papel);
  if ((tem(b, 'telefone') || tem(b, 'vinculosAtendimento')) && !gestor) {
    return res.status(403).json({ error: 'Telefone e responsáveis por departamento só podem ser alterados pela gestão.' });
  }
  const telefone = tem(b, 'telefone') ? telefoneValido(b.telefone, true) : null;
  if (tem(b, 'telefone') && telefone === undefined) {
    return res.status(400).json({ error: 'Informe um telefone válido com DDD.' });
  }
  if (tem(b, 'telefoneAlternativo') && ficha.telefoneAlternativo === undefined) {
    return res.status(400).json({ error: 'Informe um telefone alternativo válido.' });
  }

  try {
    const encontrado = await db.comTenant(req.tenantId, async (conn) => {
      if (!(await contatoNoEscopo(conn, id, req.perfil))) return false;
      const vinculos = tem(b, 'vinculosAtendimento')
        ? await validarVinculosAtendimento(conn, b.vinculosAtendimento)
        : null;

      const sets = [];
      const binds = { id, editor: req.perfil ? req.perfil.atendenteId : null };
      const adicionar = (condicao, coluna, bind, valor) => {
        if (!condicao) return;
        sets.push(`${coluna} = :${bind}`);
        binds[bind] = valor;
      };
      adicionar(tem(b, 'telefone'), 'telefone', 'tel', telefone);
      adicionar(tem(b, 'nomeInterno'), 'nome_interno', 'ni', ficha.nomeInterno);
      adicionar(tem(b, 'nomeCompleto'), 'nome_completo', 'nc', ficha.nomeCompleto);
      adicionar(tem(b, 'razaoSocial'), 'razao_social', 'rs', ficha.razaoSocial);
      adicionar(tem(b, 'nomeFantasia'), 'nome_fantasia', 'nf', ficha.nomeFantasia);
      adicionar(tem(b, 'documento'), 'documento', 'doc', ficha.documento);
      adicionar(tem(b, 'email'), 'email', 'email', ficha.email);
      adicionar(tem(b, 'telefoneAlternativo'), 'telefone_alternativo', 'ta', ficha.telefoneAlternativo);
      adicionar(tem(endereco, 'cep') || tem(b, 'cep'), 'cep', 'cep', ficha.cep);
      adicionar(tem(endereco, 'logradouro') || tem(b, 'logradouro'), 'logradouro', 'log', ficha.logradouro);
      adicionar(tem(endereco, 'numero') || tem(b, 'numeroEndereco'), 'numero_endereco', 'num', ficha.numeroEndereco);
      adicionar(tem(endereco, 'complemento') || tem(b, 'complemento'), 'complemento', 'comp', ficha.complemento);
      adicionar(tem(endereco, 'bairro') || tem(b, 'bairro'), 'bairro', 'bairro', ficha.bairro);
      adicionar(tem(endereco, 'cidade') || tem(b, 'cidade'), 'cidade', 'cidade', ficha.cidade);
      adicionar(tem(endereco, 'uf') || tem(b, 'uf'), 'uf', 'uf', ficha.uf);
      adicionar(tem(b, 'observacoes'), 'observacoes', 'obs', ficha.observacoes);
      adicionar(
        tem(b, 'codigoExterno'),
        'codigo_externo',
        'cod',
        { type: db.tipos.NUMBER, val: codigoExterno }
      );
      if (tem(b, 'tags')) {
        const tags = Array.isArray(b.tags) ? b.tags.map(Number).filter(Number.isInteger) : [];
        adicionar(true, 'tags_contato', 'tags', tags.length ? JSON.stringify(tags) : null);
      }
      if (!sets.length && !tem(b, 'vinculosAtendimento')) {
        const erro = new Error('Nenhuma alteração informada.');
        erro.status = 400;
        throw erro;
      }
      sets.push('atualizado_por = :editor', 'atualizado_em = now()');
      await conn.execute(
        `UPDATE contato SET ${sets.join(', ')} WHERE id = :id`,
        binds
      );
      if (tem(b, 'vinculosAtendimento')) {
        await salvarVinculosAtendimento(conn, id, vinculos, req.perfil ? req.perfil.atendenteId : null);
      }
      // Trilha "editado por/em".
      await conn.execute(
        `INSERT INTO auditoria (atendente_id, matricula, acao, entidade, entidade_id, detalhe)
         VALUES (:atd, :m, 'edicao_contato', 'contato', :id, :det)`,
        {
          atd: req.perfil ? req.perfil.atendenteId : null,
          m: req.user ? req.user.matricula : null,
          id,
          det: JSON.stringify({
            campos: [
              ...sets.filter((s) => !s.startsWith('atualizado_')).map((s) => s.split(' = ')[0]),
              ...(tem(b, 'vinculosAtendimento') ? ['vinculos_atendimento'] : []),
            ],
            nomeInterno: tem(b, 'nomeInterno') ? ficha.nomeInterno : undefined,
            vinculosAtendimento: tem(b, 'vinculosAtendimento') ? vinculos : undefined,
          }),
        }
      );
      return true;
    });
    if (!encontrado) return res.status(404).json({ error: 'Contato não encontrado' });
    publish({ tipo: 'contato', contatoId: id, tenantId: req.tenantId });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe um cliente com este telefone.' });
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// GET /api/contatos/:id/cobranca — mini-painel de cobrança do cliente vinculado
// ao contato. O fork original lia MCCANAL.PCPREST (WinThor, ERP on-prem) — essa
// tabela não existe no Postgres/Neon (não é dado migrado, é de outro sistema).
// Sem um provedor de cobrança por tenant (fora deste ticket — não é o seam de
// clienteLookup.js, que só resolve IDENTIFICAÇÃO), o endpoint degrada para
// "sem dados", igual ao clienteLookup faz sem provedor registrado.
router.get('/:id/cobranca', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const row = await db.comTenant(req.tenantId, (conn) => contatoNoEscopo(conn, id, req.perfil));
    if (!row) return res.status(404).json({ error: 'Contato não encontrado' });
    res.json({ codigoExterno: row.CODIGO_EXTERNO || null, resumo: null, titulos: [] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
