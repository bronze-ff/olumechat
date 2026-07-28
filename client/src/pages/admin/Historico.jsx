import { useState, Fragment } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import Spinner from '../../components/ui/Spinner';
import Portal from '../../components/ui/Portal';
import Anexo from '../../components/ui/Anexo';
import { formatPhone, formatTime, formatDateTime, formatDiaSeparador, diaMudou } from '../../utils/formatters';

const STATUS = [
  ['', 'Todos'], ['resolvida', 'Resolvidos'], ['em_atendimento', 'Em atendimento'],
  ['aguardando', 'Na fila'], ['bot', 'No bot'],
];

// Chips rápidos (atalhos) — clicar aplica o filtro de status e mostra a contagem.
const CHIPS = [
  { st: 'em_atendimento', label: 'Em atendimento', txt: 'text-brand-700' },
  { st: 'aguardando', label: 'Aguardando', txt: 'text-amber-600' },
  { st: 'bot', label: 'Em fluxo', txt: 'text-purple-600' },
  { st: 'resolvida', label: 'Resolvidos', txt: 'text-emerald-600' },
];

// Modal de atendimento (read-only) com dois modos:
//  • preview: compacto, cabeçalho + thread + aviso "não marca como lida" + botão Abrir.
//  • full: grande, barra de metadados completa + linha do tempo (eventos) + thread.
function AtendimentoModal({ conversa: c, modo, onClose, onAbrir }) {
  const full = modo === 'full';
  const msgs = useQuery({
    queryKey: ['mensagens', c.id],
    queryFn: () => api.get(`/conversas/${c.id}/mensagens`).then((r) => r.data),
  });
  const timeline = useQuery({
    queryKey: ['atendimento-eventos', c.id],
    queryFn: () => api.get(`/historico/${c.id}/atendimento`).then((r) => r.data),
    enabled: full,
  });

  const META = [
    ['Protocolo', c.protocolo || '—'],
    ['Tipo', c.origem === 'ativa' ? 'Ativa' : 'Receptiva'],
    ['Canal', c.numeroNome || formatPhone(c.numeroFone) || '—'],
    ['Departamento', c.departamento || '—'],
    ['Atendente', c.atendente || '—'],
    ['Status', c.filaStatus || '—'],
    ['Criado', c.criadoEm ? new Date(c.criadoEm).toLocaleString('pt-BR') : '—'],
    ['Finalizado', c.resolvidaEm ? new Date(c.resolvidaEm).toLocaleString('pt-BR') : '—'],
  ];

  const Thread = () => (
    <div className="flex-1 overflow-y-auto p-4 bg-paper-200 space-y-1.5">
      {msgs.isLoading && <div className="p-6 flex justify-center"><Spinner /></div>}
      {(msgs.data || []).map((m, i) => (
        <Fragment key={m.id}>
          {diaMudou(m.ts, (msgs.data || [])[i - 1]?.ts) && (
            <div className="flex justify-center my-2">
              <span className="text-[10px] font-mono uppercase tracking-wide text-stone-500 bg-stone-100 border border-black/[0.05] rounded-full px-3 py-1">{formatDiaSeparador(m.ts)}</span>
            </div>
          )}
          {m.direcao === 'nota' ? (
            <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 max-w-md mx-auto">
              {m.conteudo}
            </div>
          ) : (
            <div className={`flex ${m.direcao === 'out' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-2xl px-3 py-1.5 text-sm whitespace-pre-wrap
                ${m.direcao === 'out' ? 'bg-brand-700 text-white rounded-br-sm' : 'bg-white border border-black/[0.07] text-stone-800 rounded-bl-sm'}`}>
                {m.mediaId && <div className="mb-1"><Anexo m={m} out={m.direcao === 'out'} /></div>}
                {m.conteudo ? m.conteudo : (!m.mediaId && <em className="opacity-60">[{m.tipo}]</em>)}
                <div className={`text-[9px] mt-0.5 text-right ${m.direcao === 'out' ? 'text-white/85' : 'text-stone-400'}`} title={formatDateTime(m.ts)}>
                  {formatTime(m.ts)}
                </div>
              </div>
            </div>
          )}
        </Fragment>
      ))}
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className={`relative w-full bg-white rounded-2xl overflow-hidden max-h-[88vh] flex flex-col ${full ? 'max-w-4xl' : 'max-w-lg'}`}>
        <div className="navy-gradient text-white px-4 py-3 flex items-center gap-2 shrink-0">
          <span className="section-bar" />
          <div className="flex-1 min-w-0">
            <h2 className="font-display font-bold text-sm truncate">{c.nomePerfil || formatPhone(c.telefone)}</h2>
            <p className="text-[10px] font-mono text-white/60 truncate">
              {formatPhone(c.telefone)}{c.codcli ? ` · #${c.codcli}` : ''}{c.protocolo ? ` · ${c.protocolo}` : ''}
            </p>
          </div>
          {!full && <span className="text-[9px] uppercase tracking-wide bg-white/15 rounded px-1.5 py-0.5 shrink-0">Prévia</span>}
          <button onClick={onClose} className="text-white/70 hover:text-white" aria-label="Fechar">✕</button>
        </div>

        {full && (
          <div className="shrink-0 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1.5 px-4 py-2.5 bg-paper-50 border-b border-black/[0.06]">
            {META.map(([k, v]) => (
              <div key={k} className="min-w-0">
                <div className="text-[9px] uppercase tracking-wide text-stone-400">{k}</div>
                <div className="text-xs text-stone-700 truncate" title={String(v)}>{v}</div>
              </div>
            ))}
          </div>
        )}

        <div className={`flex-1 min-h-0 ${full ? 'flex' : 'flex flex-col'}`}>
          {full && (
            <div className="w-60 shrink-0 border-r border-black/[0.06] overflow-y-auto p-3 bg-white">
              <div className="text-[10px] uppercase tracking-wide text-stone-400 mb-2">Histórico do atendimento</div>
              {timeline.isLoading && <Spinner />}
              <ol className="space-y-2.5">
                {(timeline.data?.eventos || []).map((e, i) => (
                  <li key={i} className="relative pl-4">
                    <span className="absolute left-0 top-1 w-2 h-2 rounded-full bg-brand-400" />
                    <div className="text-[11px] text-stone-700 leading-snug">{e.texto}</div>
                    <div className="text-[10px] text-stone-400">
                      {e.ts ? new Date(e.ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}
                    </div>
                  </li>
                ))}
                {timeline.data && timeline.data.eventos.length === 0 && (
                  <li className="text-[11px] text-stone-400">Sem eventos registrados.</li>
                )}
              </ol>
            </div>
          )}
          <Thread />
        </div>

        {!full && (
          <div className="shrink-0 flex items-center justify-between gap-2 px-4 py-2.5 border-t border-black/[0.06] bg-white">
            <span className="text-[11px] text-stone-400">Pré-visualização — não marca como lida.</span>
            <button onClick={onAbrir} className="text-xs px-3 py-1.5 rounded-lg bg-brand-700 hover:bg-brand-800 text-white font-semibold">
              Abrir atendimento
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Modal de ação forçada do admin (transferência ou finalização em lote).
function ForcarModal({ tipo, ids, deptos, atendentes, onClose, onDone }) {
  const ehTransf = tipo === 'transferir';
  const [modo, setModo] = useState('atendente');
  const [atd, setAtd] = useState('');
  const [dep, setDep] = useState('');
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState('');

  async function executar() {
    setErro(''); setBusy(true);
    try {
      const CHUNK = 200; // backend aceita até 200 por requisição; envia em blocos
      const agg = { ok: 0, total: ids.length, erros: [] };
      for (let i = 0; i < ids.length; i += CHUNK) {
        const lote = ids.slice(i, i + CHUNK);
        let data;
        if (ehTransf) {
          const body = { ids: lote };
          if (modo === 'atendente') body.atendenteId = Number(atd); else body.departamentoId = Number(dep);
          ({ data } = await api.post('/conversas/forcar-transferir', body));
        } else {
          ({ data } = await api.post('/conversas/forcar-finalizar', { ids: lote }));
        }
        agg.ok += data.ok || 0;
        if (data.erros) agg.erros.push(...data.erros);
      }
      onDone(agg);
    } catch (e) {
      setErro(e.response?.data?.error || 'Falha na operação.');
      setBusy(false);
    }
  }
  const podeEnviar = ehTransf ? (modo === 'atendente' ? !!atd : !!dep) : true;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white rounded-2xl overflow-hidden">
        <div className={`px-4 py-3 flex items-center gap-2 text-white ${ehTransf ? 'navy-gradient' : 'bg-bordeaux-700'}`}>
          <span className="section-bar" />
          <h3 className="font-display font-bold text-base">{ehTransf ? 'Forçar transferência' : 'Forçar finalização'}</h3>
          <button onClick={onClose} className="ml-auto text-white/80 hover:text-white text-xl leading-none" aria-label="Fechar">×</button>
        </div>
        <div className="p-4 space-y-3">
          <p className="text-sm text-stone-600"><strong>{ids.length}</strong> atendimento(s) selecionado(s).</p>
          {ehTransf ? (
            <>
              <div className="flex gap-2">
                <button type="button" onClick={() => setModo('atendente')}
                  className={`flex-1 py-1.5 rounded-lg text-sm border ${modo === 'atendente' ? 'border-brand-700 bg-brand-50 text-brand-700' : 'border-black/10 text-stone-600'}`}>Para um atendente</button>
                <button type="button" onClick={() => setModo('departamento')}
                  className={`flex-1 py-1.5 rounded-lg text-sm border ${modo === 'departamento' ? 'border-brand-700 bg-brand-50 text-brand-700' : 'border-black/10 text-stone-600'}`}>Para um departamento</button>
              </div>
              {modo === 'atendente' ? (
                <select className="input-field" value={atd} onChange={(e) => setAtd(e.target.value)}>
                  <option value="">Selecione o atendente…</option>
                  {atendentes.map((a) => <option key={a.id} value={a.id}>{a.nome || `Matrícula ${a.matricula}`}</option>)}
                </select>
              ) : (
                <select className="input-field" value={dep} onChange={(e) => setDep(e.target.value)}>
                  <option value="">Selecione o departamento…</option>
                  {deptos.map((d) => <option key={d.id} value={d.id}>{d.nome}</option>)}
                </select>
              )}
              <p className="text-xs text-stone-400">Atendente: atribui direto a ele. Departamento: volta pra fila e a distribuição reparte entre quem estiver disponível.</p>
            </>
          ) : (
            <p className="text-sm text-stone-600">As conversas serão marcadas como <strong>resolvidas</strong> e saem da fila. Não envia mensagem de despedida ao cliente.</p>
          )}
          {erro && <p className="text-sm text-red-600">{erro}</p>}
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className="flex-1 py-2 rounded-lg border border-black/15 text-stone-600 text-sm">Cancelar</button>
            <button type="button" onClick={executar} disabled={!podeEnviar || busy}
              className={`flex-1 py-2 rounded-lg text-white text-sm font-semibold disabled:opacity-40 ${ehTransf ? 'bg-brand-700 hover:bg-brand-800' : 'bg-bordeaux-700 hover:bg-bordeaux-800'}`}>
              {busy ? 'Processando…' : (ehTransf ? 'Transferir' : 'Finalizar')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Historico() {
  const [filtros, setFiltros] = useState({ protocolo: '', q: '', departamentoId: '', atendenteId: '', filaStatus: '', origem: '', de: '', ate: '' });
  const [pagina, setPagina] = useState(1);
  const [porPagina, setPorPagina] = useState(25);
  const [ord, setOrd] = useState({ by: 'criado', dir: 'desc' });
  const [vendo, setVendo] = useState(null);
  const [exportando, setExportando] = useState(false);
  const { user } = useAuth();
  const ehAdmin = user?.papel === 'ADMIN';
  const qc = useQueryClient();
  const [sel, setSel] = useState(() => new Set());
  const [forcar, setForcar] = useState(null); // { tipo: 'transferir' | 'finalizar' }
  const [resultado, setResultado] = useState('');

  const deptos = useQuery({ queryKey: ['departamentos'], queryFn: () => api.get('/departamentos').then((r) => r.data) });
  const atendentes = useQuery({ queryKey: ['atendentes'], queryFn: () => api.get('/atendentes').then((r) => r.data) });

  const params = Object.fromEntries(Object.entries({ ...filtros, pagina, porPagina, orderBy: ord.by, dir: ord.dir }).filter(([, v]) => v !== '' && v !== null));
  const dados = useQuery({
    queryKey: ['historico', params],
    queryFn: () => api.get('/historico', { params }).then((r) => r.data),
    keepPreviousData: true,
  });

  // Contagem por status (ignora o próprio filtro de status) → alimenta os chips.
  const paramsContagem = Object.fromEntries(
    Object.entries(filtros).filter(([k, v]) => k !== 'filaStatus' && v !== '' && v !== null)
  );
  const contagens = useQuery({
    queryKey: ['historico-contagens', paramsContagem],
    queryFn: () => api.get('/historico/contagens', { params: paramsContagem }).then((r) => r.data),
  });

  const setF = (k, v) => { setFiltros((f) => ({ ...f, [k]: v })); setPagina(1); limparSel(); };
  const ordenarPor = (by) => { setOrd((o) => ({ by, dir: o.by === by && o.dir === 'desc' ? 'asc' : 'desc' })); setPagina(1); limparSel(); };
  // Cabeçalho clicável (ordena asc/desc). by=null → coluna não-ordenável.
  const th = (by, label, right) => (
    <th className={`px-2 py-2 font-semibold select-none ${by ? 'cursor-pointer hover:text-stone-700' : ''}${right ? ' text-right' : ''}`}
      onClick={by ? () => ordenarPor(by) : undefined}>
      {label}{by && ord.by === by ? (ord.dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  );

  async function exportarCsv() {
    setExportando(true);
    try {
      const { data } = await api.get('/historico/export.csv', { params, responseType: 'blob' });
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url; a.download = 'atendimentos.csv'; a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert('Falha ao exportar.');
    } finally {
      setExportando(false);
    }
  }

  const totalPaginas = dados.data ? Math.max(1, Math.ceil(dados.data.total / dados.data.porPagina)) : 1;

  // Seleção em lote (admin) — checkboxes + barra de ações forçadas.
  const itens = dados.data?.itens || [];
  const idsPagina = itens.map((c) => c.id);
  const todosSel = idsPagina.length > 0 && idsPagina.every((id) => sel.has(id));
  const toggle = (id) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleTodos = () => setSel((s) => {
    const n = new Set(s);
    if (todosSel) idsPagina.forEach((id) => n.delete(id)); else idsPagina.forEach((id) => n.add(id));
    return n;
  });
  const limparSel = () => setSel(new Set());
  const aposAcao = (r) => {
    limparSel(); setForcar(null);
    // Agrupa os erros por motivo (ex.: "23 já resolvida") em vez de só "23 com erro".
    const porMotivo = {};
    (r.erros || []).forEach((e) => { porMotivo[e.error] = (porMotivo[e.error] || 0) + 1; });
    const detalhe = Object.entries(porMotivo).map(([m, n]) => `${n} ${m}`).join(' · ');
    setResultado(`${r.ok} de ${r.total} processada(s)${detalhe ? ` · ${detalhe}` : ''}.`);
    qc.invalidateQueries({ queryKey: ['historico'] });
    qc.invalidateQueries({ queryKey: ['historico-contagens'] });
  };

  return (
    <div className="max-w-screen-2xl mx-auto space-y-4">
      {/* Chips rápidos: contagem por status; clicar aplica/limpa o filtro */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        {CHIPS.map(({ st, label, txt }) => {
          const ativo = filtros.filaStatus === st;
          return (
            <button key={st} type="button" onClick={() => setF('filaStatus', ativo ? '' : st)}
              className={`rounded-xl border p-3 text-left transition-colors
                ${ativo ? 'border-brand-700 bg-brand-50 ring-1 ring-brand-700' : 'border-black/[0.06] bg-white hover:border-stone-300'}`}>
              <div className={`text-xl font-bold font-mono ${txt}`}>{contagens.data?.[st] ?? '…'}</div>
              <div className="text-[11px] text-stone-500">{label}</div>
            </button>
          );
        })}
      </div>
      {/* Filtros */}
      <div className="bg-white rounded-2xl border border-black/[0.06] p-3.5 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2.5">
        <input className="input-field !py-2 !text-sm font-mono" placeholder="Protocolo"
          value={filtros.protocolo} onChange={(e) => setF('protocolo', e.target.value)} />
        <input className="input-field !py-2 !text-sm" placeholder="Nome ou telefone"
          value={filtros.q} onChange={(e) => setF('q', e.target.value)} />
        <select className="input-field !py-2 !text-sm" value={filtros.departamentoId}
          onChange={(e) => setF('departamentoId', e.target.value)}>
          <option value="">Todos os deptos</option>
          {(deptos.data || []).map((d) => <option key={d.id} value={d.id}>{d.nome}</option>)}
        </select>
        <select className="input-field !py-2 !text-sm" value={filtros.atendenteId}
          onChange={(e) => setF('atendenteId', e.target.value)}>
          <option value="">Todos os atendentes</option>
          {(atendentes.data || []).map((a) => <option key={a.id} value={a.id}>{a.nome || `Matrícula ${a.matricula}`}</option>)}
        </select>
        <select className="input-field !py-2 !text-sm" value={filtros.filaStatus}
          onChange={(e) => setF('filaStatus', e.target.value)}>
          {STATUS.map(([v, r]) => <option key={v} value={v}>{r}</option>)}
        </select>
        <select className="input-field !py-2 !text-sm" value={filtros.origem}
          onChange={(e) => setF('origem', e.target.value)} title="Receptiva = cliente iniciou · Ativa = nós iniciamos (cobrança ativa)">
          <option value="">Ativas e receptivas</option>
          <option value="receptiva">Só receptivas</option>
          <option value="ativa">Só ativas</option>
        </select>
        <input type="date" className="input-field !py-2 !text-sm" value={filtros.de}
          onChange={(e) => setF('de', e.target.value)} />
        <input type="date" className="input-field !py-2 !text-sm" value={filtros.ate}
          onChange={(e) => setF('ate', e.target.value)} />
      </div>

      {/* Tabela */}
      <div className="bg-white rounded-2xl border border-black/[0.06] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-black/[0.05]">
          <p className="text-xs text-stone-500">{dados.data ? `${dados.data.total} atendimento(s)` : '…'}</p>
          <div className="flex items-center gap-2">
            <label className="text-xs text-stone-500">Mostrar</label>
            <select value={porPagina} onChange={(e) => { setPorPagina(Number(e.target.value)); setPagina(1); limparSel(); }}
              className="border border-black/15 rounded-lg text-xs px-2 py-1 bg-white text-stone-700">
              {[25, 50, 100, 500].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <button onClick={exportarCsv} disabled={exportando || !dados.data?.total}
              className="text-xs px-3 py-1.5 rounded-lg border border-black/15 text-stone-600 hover:bg-paper-50 font-medium disabled:opacity-40">
              {exportando ? 'Exportando…' : '⬇ Exportar CSV'}
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-stone-400 border-b border-black/[0.05]">
                {ehAdmin && (
                  <th className="px-3 py-2 w-8">
                    <input type="checkbox" checked={todosSel} onChange={toggleTodos} aria-label="Selecionar todos da página" />
                  </th>
                )}
                {th('protocolo', 'Protocolo')}
                {th('cliente', 'Cliente')}
                {th(null, 'Origem')}
                {th('departamento', 'Departamento')}
                {th('atendente', 'Atendente')}
                {th('status', 'Status')}
                {th('criado', 'Início')}
                {th('finalizado', 'Finalizado')}
                {th(null, 'Última mensagem')}
                {th(null, 'Ações', true)}
              </tr>
            </thead>
            <tbody>
              {dados.isLoading && (
                <tr><td colSpan={ehAdmin ? 11 : 10} className="p-8 text-center"><Spinner /></td></tr>
              )}
              {itens.map((c) => (
                <tr key={c.id} onClick={() => setVendo({ c, modo: 'preview' })}
                  className={`border-b border-black/[0.04] last:border-0 hover:bg-paper-50 cursor-pointer ${sel.has(c.id) ? 'bg-brand-50/40' : ''}`}>
                  {ehAdmin && (
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)} aria-label="Selecionar atendimento" />
                    </td>
                  )}
                  <td className="px-4 py-2 font-mono text-xs text-stone-600">{c.protocolo || '—'}</td>
                  <td className="px-2 py-2">
                    <span className="text-stone-800">{c.nomePerfil || formatPhone(c.telefone)}</span>
                    {c.codcli && <span className="text-[10px] font-mono text-stone-400 ml-1">#{c.codcli}</span>}
                  </td>
                  <td className="px-2 py-2">
                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${c.origem === 'ativa' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-50 text-emerald-700'}`}>
                      {c.origem === 'ativa' ? 'Ativa' : 'Receptiva'}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-stone-600 text-xs">{c.departamento || '—'}</td>
                  <td className="px-2 py-2 text-stone-600 text-xs">{c.atendente || '—'}</td>
                  <td className="px-2 py-2">
                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded
                      ${c.filaStatus === 'resolvida' ? 'bg-emerald-50 text-emerald-700'
                        : c.filaStatus === 'aguardando' ? 'bg-amber-100 text-amber-700'
                        : c.filaStatus === 'bot' ? 'bg-purple-50 text-purple-700'
                        : 'bg-brand-50 text-brand-700'}`}>
                      {c.filaStatus}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-xs text-stone-500">
                    {c.criadoEm ? new Date(c.criadoEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                  </td>
                  <td className="px-2 py-2 text-xs text-stone-500">
                    {c.resolvidaEm ? new Date(c.resolvidaEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                  </td>
                  <td className="px-2 py-2 text-xs text-stone-500">
                    <div className="max-w-[16rem] truncate" title={c.ultimaMsg || ''}>{c.ultimaMsg || '—'}</div>
                  </td>
                  <td className="px-2 py-2 text-right whitespace-nowrap">
                    <button onClick={(e) => { e.stopPropagation(); setVendo({ c, modo: 'preview' }); }}
                      title="Pré-visualizar" aria-label="Pré-visualizar"
                      className="p-1.5 rounded-lg text-stone-400 hover:text-brand-700 hover:bg-brand-50">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); setVendo({ c, modo: 'full' }); }}
                      title="Abrir atendimento" aria-label="Abrir atendimento"
                      className="p-1.5 rounded-lg text-stone-400 hover:text-brand-700 hover:bg-brand-50">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                    </button>
                  </td>
                </tr>
              ))}
              {itens.length === 0 && !dados.isLoading && (
                <tr><td colSpan={ehAdmin ? 11 : 10} className="p-6 text-center text-sm text-stone-400">Nenhum atendimento com esses filtros.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {/* Paginação */}
        {totalPaginas > 1 && (
          <div className="flex items-center justify-center gap-3 px-4 py-2.5 border-t border-black/[0.05]">
            <button onClick={() => { limparSel(); setPagina((p) => Math.max(1, p - 1)); }} disabled={pagina <= 1}
              className="text-xs px-2.5 py-1 rounded border border-black/15 disabled:opacity-30">← Anterior</button>
            <span className="text-xs text-stone-500 font-mono">{pagina} / {totalPaginas}</span>
            <button onClick={() => { limparSel(); setPagina((p) => Math.min(totalPaginas, p + 1)); }} disabled={pagina >= totalPaginas}
              className="text-xs px-2.5 py-1 rounded border border-black/15 disabled:opacity-30">Próxima →</button>
          </div>
        )}
      </div>

      {vendo && (
        <Portal>
          <AtendimentoModal
            conversa={vendo.c}
            modo={vendo.modo}
            onClose={() => setVendo(null)}
            onAbrir={() => setVendo((v) => v && { ...v, modo: 'full' })}
          />
        </Portal>
      )}

      {/* Barra de ações forçadas (admin) — Portal p/ flutuar SEMPRE na base da viewport
          (sem Portal, um ancestral com transform ancorava o 'fixed' e ela só aparecia
          no fim da página, obrigando a rolar). */}
      {ehAdmin && sel.size > 0 && (
        <Portal>
          <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 bg-white border border-black/10 rounded-2xl shadow-xl px-4 py-3">
            <span className="text-sm text-stone-600">{sel.size} selecionado(s)</span>
            <button type="button" onClick={limparSel} className="text-xs text-stone-400 hover:text-stone-600">limpar</button>
            <button type="button" onClick={() => setForcar({ tipo: 'transferir' })}
              className="px-3 py-1.5 rounded-lg bg-brand-700 text-white text-sm font-semibold hover:bg-brand-800">Forçar transferência</button>
            <button type="button" onClick={() => setForcar({ tipo: 'finalizar' })}
              className="px-3 py-1.5 rounded-lg bg-bordeaux-700 text-white text-sm font-semibold hover:bg-bordeaux-800">Forçar finalização</button>
          </div>
        </Portal>
      )}
      {resultado && (
        <Portal>
          <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-ink-950 text-white text-sm px-4 py-2 rounded-lg shadow-lg flex items-center gap-3">
            <span>{resultado}</span>
            <button type="button" onClick={() => setResultado('')} className="text-white/60 hover:text-white" aria-label="Fechar">✕</button>
          </div>
        </Portal>
      )}
      {forcar && (
        <Portal>
          <ForcarModal tipo={forcar.tipo} ids={[...sel]} deptos={deptos.data || []} atendentes={atendentes.data || []}
            onClose={() => setForcar(null)} onDone={aposAcao} />
        </Portal>
      )}
    </div>
  );
}
