import { useState, useEffect, useRef, Fragment } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import api from '../services/api';
import Header from '../components/layout/Header';
import Spinner from '../components/ui/Spinner';
import Anexo from '../components/ui/Anexo';
import TagsConversa from '../components/TagsConversa';
import PedidosIa from '../components/PedidosIa';
import { AtalhosDropdown, AtalhosModal } from '../components/Atalhos';
import useEventStream from '../hooks/useEventStream';
import { useAuth } from '../context/AuthContext';
import NovaConversa from './NovaConversa';
import Icon from '../components/ui/Icon';
import { BrandMark } from '../components/ui/Brand';
import ThemeMenu from '../components/ui/ThemeMenu';
import { formatTime, formatDateTime, formatDiaSeparador, diaMudou, formatHoraOuDia, formatPhone, janelaRestante } from '../utils/formatters';

// Rótulo do status da mensagem enviada (a Meta devolve em inglês).
const STATUS_MSG = { sent: 'enviado', delivered: 'entregue', read: 'lido', failed: 'falha' };

// Bip curto via WebAudio (sem asset) — toca quando entra conversa na minha fila.
function tocarBip() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.start(); osc.stop(ctx.currentTime + 0.35);
  } catch { /* sem áudio, sem problema */ }
}

// Inbox = só o operacional. Resolvidos e o arquivo completo ficam no
// Admin → Histórico (paginado/filtrável) — não despejamos tudo aqui.
const ABAS_FILA = [
  { id: 'aguardando', rotulo: 'Aguardando', params: { fila: 'aguardando' } },
  { id: 'minhas', rotulo: 'Minhas', params: { fila: 'em_atendimento', minhas: '1' } },
];

function iniciais(nome, tel) {
  const base = (nome || tel || '?').trim();
  const parts = base.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return base.slice(0, 2).toUpperCase();
}

function JanelaBadge({ expiraIso }) {
  const min = janelaRestante(expiraIso);
  if (min === null) return null;
  if (min <= 0) return <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-stone-200 text-stone-500">janela fechada</span>;
  const h = Math.floor(min / 60), m = min % 60;
  const cor = min < 60 ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700';
  return <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${cor}`}>{h > 0 ? `${h}h${m}m` : `${m}m`}</span>;
}

// Chip do departamento (bolinha colorida + nome) — deixa claro de qual fila é a
// conversa sem precisar abri-la. Conversa sem departamento (bot/inbox geral) = "Geral".
function DeptoBadge({ nome, cor }) {
  const geral = !nome;
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-stone-500 shrink-0 min-w-0">
      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: geral ? '#80978F' : (cor || '#1F7A60') }} />
      <span className="truncate">{geral ? 'Geral' : nome}</span>
    </span>
  );
}

// Chip do NÚMERO da empresa pelo qual a conversa corre (multi-número) — separa
// visualmente, por ex., a cobrança ativa (1061) do atendimento receptivo (1090).
function NumeroBadge({ nome, fone }) {
  if (!nome && !fone) return null;
  const rotulo = nome || (fone ? `…${String(fone).slice(-4)}` : '');
  return (
    <span className="font-mono text-[9px] text-stone-400 shrink-0 truncate" title={`Número: ${nome || fone}`}>
      via {rotulo}
    </span>
  );
}

function ConversaItem({ c, ativo, onClick }) {
  return (
    <button onClick={onClick}
      className={`w-full text-left flex gap-3 px-4 py-3 border-b border-black/[0.05] transition-colors
        ${ativo ? 'bg-brand-50' : 'hover:bg-paper-50'}`}>
      <div className="w-10 h-10 shrink-0 rounded-full navy-gradient text-white flex items-center justify-center font-mono text-xs">
        {iniciais(c.nomeInterno || c.nomePerfil, c.telefone)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold text-sm text-stone-800 flex items-center gap-1.5 min-w-0">
            <span className="truncate">{c.nomeInterno || c.nomePerfil || formatPhone(c.telefone)}</span>
            <span className={`text-[8px] font-mono uppercase px-1 py-0.5 rounded shrink-0
              ${c.origem === 'ativa' ? 'bg-bordeaux-700/10 text-bordeaux-700' : 'bg-emerald-100 text-emerald-700'}`}>
              {c.origem === 'ativa' ? 'ativa' : 'receptiva'}
            </span>
          </span>
          <span className="text-[11px] text-stone-400 shrink-0" title={formatDateTime(c.ultimaMsgEm)}>{formatHoraOuDia(c.ultimaMsgEm)}</span>
        </div>
        <div className="flex items-center justify-between gap-2 mt-0.5">
          <span className="text-xs text-stone-500 truncate">{c.ultimaMsg || '—'}</span>
          {c.filaStatus === 'aguardando' ? (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 animate-pulse shrink-0">na fila</span>
          ) : c.filaStatus === 'ia' ? (
            <span className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-brand-50 text-brand-700 shrink-0">
              <Icon name="bot" size={11} /> IA
            </span>
          ) : c.filaStatus === 'resolvida' ? (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-stone-100 text-stone-400 shrink-0">encerrada</span>
          ) : (
            <JanelaBadge expiraIso={c.janelaExpiraEm} />
          )}
        </div>
        <div className="flex items-center gap-2 mt-1 min-w-0">
          <DeptoBadge nome={c.departamentoNome} cor={c.departamentoCor} />
          <NumeroBadge nome={c.numeroNome} fone={c.numeroFone} />
          {c.atendenteNome && c.filaStatus === 'em_atendimento' && (
            <span className="text-[10px] text-stone-400 truncate min-w-0">→ {c.atendenteNome}</span>
          )}
        </div>
      </div>
    </button>
  );
}

// Divisor de dia no thread (estilo WhatsApp): "Hoje" / "Ontem" / data.
function DiaSeparador({ label }) {
  return (
    <div className="flex justify-center my-3">
      <span className="text-[10px] font-mono uppercase tracking-wide text-stone-500 bg-stone-100 border border-black/[0.05] rounded-full px-3 py-1">
        {label}
      </span>
    </div>
  );
}

// FIL-84: a timeline distingue QUEM escreveu (mensagem.origem). Antes o único
// sinal era "sem atendente_id", que valia igual para o bot de fluxo, para a IA
// e para o aviso automático — e sem isso o atendente que assume uma conversa
// não tem como saber o que foi a IA que disse em nome da empresa.
const ROTULO_ORIGEM = {
  ia: { texto: 'agente de IA', classe: 'bg-brand-800' },
  bot: { texto: 'autoatendimento', classe: 'bg-stone-600' },
  sistema: { texto: 'automático', classe: 'bg-stone-500' },
};

function Bolha({ m }) {
  if (m.direcao === 'nota') {
    return (
      <div className="flex justify-center my-2">
        <div className="max-w-md text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          {/* FIL-85: a IA passou a AGIR (ficha, etiqueta, pedido) e cada ação
              vira nota com origem='ia'. Chamar isso de "nota interna" faria o
              atendente achar que um colega escreveu aquilo. */}
          <span className="font-mono uppercase text-[10px] tracking-wide text-amber-600">
            {m.origem === 'ia' ? 'ação do agente de IA'
              : m.origem === 'sistema' ? 'evento do sistema' : 'nota interna'}
          </span>
          <p className="mt-0.5 whitespace-pre-wrap">{m.conteudo}</p>
        </div>
      </div>
    );
  }
  const out = m.direcao === 'out';
  const marca = out ? ROTULO_ORIGEM[m.origem] : null;
  return (
    <div className={`flex my-1 ${out ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm
        ${out ? `${marca ? marca.classe : 'bg-brand-700'} text-white rounded-br-sm` : 'bg-white border border-black/[0.07] text-stone-800 rounded-bl-sm'}`}>
        {marca && (
          <div className="flex items-center gap-1 mb-0.5 text-[10px] font-mono uppercase tracking-wide text-white/75">
            {m.origem === 'ia' && <Icon name="bot" size={11} />}
            {marca.texto}
          </div>
        )}
        {m.mediaId && <div className="mb-1"><Anexo m={m} out={out} /></div>}
        {m.conteudo && <p className="whitespace-pre-wrap break-words">{m.conteudo}</p>}
        <div className={`text-[10px] mt-1 text-right ${out ? 'text-white/85' : 'text-stone-400'}`} title={formatDateTime(m.ts)}>
          {formatTime(m.ts)}{out && m.status ? ` · ${STATUS_MSG[m.status] || m.status}` : ''}
        </div>
      </div>
    </div>
  );
}

// Modal de transferência: por DEPARTAMENTO (volta à fila e redistribui) ou —
// para gestor/admin — direto para um ATENDENTE ONLINE do departamento.
function TransferirModal({ conversa, onClose, onDone }) {
  const { user } = useAuth();
  const ehGestor = user?.papel === 'ADMIN' || user?.papel === 'SUPERVISOR';
  const [modo, setModo] = useState('depto'); // 'depto' | 'atendente'
  const [dep, setDep] = useState('');
  const [atd, setAtd] = useState('');
  const [erro, setErro] = useState('');

  const deptos = useQuery({
    queryKey: ['departamentos'],
    queryFn: () => api.get('/departamentos').then((r) => r.data),
  });
  // Presença (quem está online) — o endpoint exige gestor; usado no modo atendente.
  const presenca = useQuery({
    queryKey: ['presenca'],
    queryFn: () => api.get('/presenca').then((r) => r.data),
    enabled: ehGestor && modo === 'atendente',
    refetchInterval: 15_000,
  });
  // Online, do MESMO departamento da conversa, exceto eu mesmo.
  const onlineDoDepto = (presenca.data || []).filter((p) =>
    p.estado === 'online'
    && (p.deptoIds || []).includes(conversa.departamentoId)
    && p.matricula !== user?.matricula);

  const transferir = useMutation({
    mutationFn: () => api.post(`/conversas/${conversa.id}/transferir`,
      modo === 'atendente' ? { atendenteId: Number(atd) } : { departamentoId: Number(dep) }),
    onSuccess: onDone,
    onError: (e) => setErro(e.response?.data?.error || 'Falha ao transferir.'),
  });
  const podeEnviar = (modo === 'atendente' ? !!atd : !!dep) && !transferir.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full sm:max-w-sm bg-white rounded-t-2xl sm:rounded-2xl overflow-hidden">
        <div className="navy-gradient text-white px-4 py-3 flex items-center gap-2">
          <span className="section-bar" />
          <h2 className="font-display font-bold text-base flex-1">Transferir conversa</h2>
          <button onClick={onClose} className="text-white/70 hover:text-white" aria-label="Fechar">✕</button>
        </div>
        <div className="modal-body space-y-3">
          {ehGestor && (
            <div className="flex gap-1 bg-stone-100 rounded-lg p-1">
              {[['depto', 'Departamento'], ['atendente', 'Atendente']].map(([id, rotulo]) => (
                <button key={id} onClick={() => { setModo(id); setErro(''); }}
                  className={`flex-1 py-1.5 text-sm rounded-md font-medium transition-colors
                    ${modo === id ? 'bg-white text-brand-700 shadow-sm' : 'text-stone-500'}`}>
                  {rotulo}
                </button>
              ))}
            </div>
          )}

          {modo === 'depto' ? (
            <>
              <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600">Departamento de destino</label>
              <select className="input-field" value={dep} onChange={(e) => setDep(e.target.value)}>
                <option value="">Selecione…</option>
                {(deptos.data || []).filter((d) => d.id !== conversa.departamentoId).map((d) => (
                  <option key={d.id} value={d.id}>{d.nome}</option>
                ))}
              </select>
              <p className="text-[11px] text-stone-400">A conversa volta para a fila do departamento escolhido e é distribuída automaticamente.</p>
            </>
          ) : (
            <>
              <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600">Atendente de destino (online)</label>
              {presenca.isLoading ? (
                <p className="text-xs text-stone-400">Carregando atendentes online…</p>
              ) : onlineDoDepto.length === 0 ? (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                  Nenhum outro atendente online neste departamento agora.
                </p>
              ) : (
                <select className="input-field" value={atd} onChange={(e) => setAtd(e.target.value)}>
                  <option value="">Selecione…</option>
                  {onlineDoDepto.map((p) => (
                    <option key={p.atendenteId} value={p.atendenteId}>{p.nome || `Atendente #${p.atendenteId}`}</option>
                  ))}
                </select>
              )}
              <p className="text-[11px] text-stone-400">Vai direto para o atendente escolhido (atribuída a ele). Só aparecem os que estão online neste departamento.</p>
            </>
          )}
          {erro && <p className="text-xs text-red-600">{erro}</p>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-black/20 text-stone-700 font-semibold text-sm">Cancelar</button>
          <button onClick={() => { setErro(''); transferir.mutate(); }} disabled={!podeEnviar}
            className="flex-1 py-2.5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white font-semibold text-sm disabled:opacity-40">
            {transferir.isPending ? 'Transferindo…' : 'Transferir'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Modal de encerramento: confirma e permite despedida opcional.
// A despedida vem PRÉ-PREENCHIDA com o padrão configurado no Admin (Ajustes);
// o atendente pode editar ou apagar antes de encerrar.
function EncerrarModal({ conversa, onClose, onDone }) {
  const [despedida, setDespedida] = useState('');
  const [erro, setErro] = useState('');
  const aberta = (janelaRestante(conversa.janelaExpiraEm) ?? 0) > 0;

  const config = useQuery({
    queryKey: ['config'],
    queryFn: () => api.get('/config').then((r) => r.data),
    staleTime: 5 * 60_000,
  });
  useEffect(() => {
    if (aberta && despedida === '' && config.data?.despedida_padrao) {
      setDespedida(config.data.despedida_padrao.replace(/\{\{\s*protocolo\s*\}\}/g, conversa.protocolo || ''));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.data]);
  const encerrar = useMutation({
    mutationFn: () => api.post(`/conversas/${conversa.id}/encerrar`, { despedida: aberta ? despedida.trim() : '' }),
    onSuccess: onDone,
    onError: (e) => setErro(e.response?.data?.error || 'Falha ao encerrar.'),
  });
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full sm:max-w-sm bg-white rounded-t-2xl sm:rounded-2xl overflow-hidden">
        <div className="navy-gradient text-white px-4 py-3 flex items-center gap-2">
          <span className="section-bar" />
          <h2 className="font-display font-bold text-base flex-1">Encerrar atendimento</h2>
          <button onClick={onClose} className="text-white/70 hover:text-white" aria-label="Fechar">✕</button>
        </div>
        <div className="modal-body space-y-3">
          {conversa.protocolo && (
            <p className="text-xs text-stone-500">Protocolo <span className="font-mono font-semibold">{conversa.protocolo}</span></p>
          )}
          {aberta ? (
            <>
              <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600">Mensagem de despedida (opcional)</label>
              <textarea rows={2} className="input-field resize-none" value={despedida}
                onChange={(e) => setDespedida(e.target.value)}
                placeholder="Ex.: Atendimento encerrado. Qualquer coisa é só chamar!" />
            </>
          ) : (
            <p className="text-xs text-stone-500">Janela de 24h fechada — encerra sem mensagem ao cliente.</p>
          )}
          <p className="text-[11px] text-stone-400">Se o cliente mandar mensagem depois, abre um atendimento novo (novo protocolo).</p>
          {erro && <p className="text-xs text-red-600">{erro}</p>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-black/20 text-stone-700 font-semibold text-sm">Cancelar</button>
          <button onClick={() => encerrar.mutate()} disabled={encerrar.isPending}
            className="flex-1 py-2.5 rounded-xl bg-red-700 hover:bg-red-800 text-white font-semibold text-sm disabled:opacity-40">
            {encerrar.isPending ? 'Encerrando…' : 'Encerrar'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Ficha do contato: identifica quem é (nome interno, CNPJ, vínculo com o cliente
// do WinThor, observações, tags) e mostra os títulos em aberto. Os dados ficam
// no CONTATO → valem para todas as conversas daquele telefone.
const moedaBR = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dataBR = (d) => (d ? new Date(d).toLocaleDateString('pt-BR') : '—');

function ContatoModal({ conversa, onClose, onDone }) {
  const qc = useQueryClient();
  const cid = conversa.contatoId;
  const [nomeInterno, setNomeInterno] = useState('');
  const [documento, setDocumento] = useState('');
  const [codigoExterno, setCodigoExterno] = useState(null);
  const [observacoes, setObservacoes] = useState('');
  const [tags, setTags] = useState([]);
  const [busca, setBusca] = useState('');
  const [pronto, setPronto] = useState(false);
  const [erro, setErro] = useState('');

  const ficha = useQuery({
    queryKey: ['contato', cid],
    queryFn: () => api.get(`/contatos/${cid}`).then((r) => r.data),
    enabled: !!cid,
  });
  useEffect(() => {
    if (ficha.data && !pronto) {
      setNomeInterno(ficha.data.nomeInterno || '');
      setDocumento(ficha.data.documento || '');
      setCodigoExterno(ficha.data.codigoExterno || null);
      setObservacoes(ficha.data.observacoes || '');
      setTags(ficha.data.tags || []);
      setPronto(true);
    }
  }, [ficha.data, pronto]);

  const tagsCat = useQuery({ queryKey: ['tags'], queryFn: () => api.get('/tags').then((r) => r.data), staleTime: 5 * 60_000 });
  const cobranca = useQuery({
    queryKey: ['cobranca', cid, codigoExterno],
    queryFn: () => api.get(`/contatos/${cid}/cobranca`).then((r) => r.data),
    enabled: !!cid && !!codigoExterno,
  });

  const salvar = useMutation({
    mutationFn: () => api.put(`/contatos/${cid}`, {
      nomeInterno: nomeInterno.trim(), documento, codigoExterno,
      observacoes: observacoes.trim(), tags,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['contato', cid] }); onDone({ nomeInterno: nomeInterno.trim() || null }); },
    onError: (e) => setErro(e.response?.data?.error || 'Falha ao salvar.'),
  });

  function vincularSugestao(c) {
    setCodigoExterno(c.codigoExterno || null);
    if (c.documento) setDocumento(c.documento);
    if (!nomeInterno.trim() && c.nome) setNomeInterno(c.nome);
  }
  function toggleTag(id) { setTags((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id])); }
  const sug = ficha.data?.sugestao;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl overflow-hidden max-h-[92vh] flex flex-col">
        <div className="navy-gradient text-white px-4 py-3 flex items-center gap-2">
          <span className="section-bar" />
          <h2 className="font-display font-bold text-base flex-1">Editar contato</h2>
          <button onClick={onClose} className="text-white/70 hover:text-white" aria-label="Fechar">✕</button>
        </div>

        <div className="modal-body space-y-4">
          <p className="text-[11px] text-stone-400">
            {formatPhone(conversa.telefone)}{ficha.data?.nomePerfil ? ` · WhatsApp: ${ficha.data.nomePerfil}` : ''}
          </p>

          {/* Sugestão automática pelo telefone (contatos ainda sem cliente) */}
          {!codigoExterno && sug && (
            <div className="p-2.5 rounded-lg bg-brand-50 border border-brand-100 text-xs text-stone-700 flex items-center gap-2">
              <span className="flex-1">Parece ser <b>{sug.nome}</b> <span className="font-mono text-stone-400">#{sug.codigoExterno}</span></span>
              <button onClick={() => vincularSugestao(sug)}
                className="px-2 py-1 rounded bg-brand-700 text-white text-[11px] font-semibold">Vincular</button>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Nome interno / apelido</label>
            <input className="input-field" value={nomeInterno} onChange={(e) => setNomeInterno(e.target.value)}
              placeholder="Ex.: Padaria do João (Centro)" />
            <p className="text-[11px] text-stone-400 mt-1">Aparece no lugar do nome do WhatsApp no inbox e no topo do chat.</p>
          </div>

          {/* Vínculo sugerido pelo provedor externo do tenant, quando houver. */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Cadastro externo</label>
            {codigoExterno ? (
              <div className="flex items-center gap-2 text-sm">
                <span className="px-2 py-1 rounded bg-stone-100 font-mono text-stone-600">#{codigoExterno}</span>
                <button onClick={() => { setCodigoExterno(null); }} className="text-[11px] text-red-600 hover:underline">desvincular</button>
              </div>
            ) : (
              <p className="rounded-md border border-paper-300 bg-paper-50 px-3 py-2 text-[11px] leading-4 text-stone-500">
                Sem vínculo externo. Os dados completos e o atendente de referência ficam em Gestão → Clientes.
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">CNPJ / CPF</label>
            <input className="input-field font-mono" value={documento} onChange={(e) => setDocumento(e.target.value)} placeholder="Só números" inputMode="numeric" />
          </div>

          {/* Tags do contato (reusa o catálogo) */}
          {(tagsCat.data || []).length > 0 && (
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Tags do contato</label>
              <div className="flex flex-wrap gap-1.5">
                {tagsCat.data.map((t) => {
                  const on = tags.includes(t.id);
                  return (
                    <button key={t.id} onClick={() => toggleTag(t.id)}
                      className={`text-[11px] px-2 py-1 rounded-full border ${on ? 'text-white border-transparent' : 'text-stone-500 border-black/15'}`}
                      style={on ? { backgroundColor: t.cor || '#1F7A60' } : {}}>
                      {t.nome}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Observações</label>
            <textarea rows={2} className="input-field resize-none" value={observacoes} onChange={(e) => setObservacoes(e.target.value)}
              placeholder="Anotações internas sobre o contato…" />
          </div>

          {/* Dados do cliente no sistema do tenant (vendedor / supervisor / telefones) —
              vem do seam clienteLookup (dadosDoCliente), null sem provedor registrado. */}
          {codigoExterno && ficha.data?.dadosExternos && (ficha.data.dadosExternos.vendedor || ficha.data.dadosExternos.supervisor || (ficha.data.dadosExternos.telefonesCliente || []).length > 0) && (
            <div className="rounded-lg border border-black/[0.07] overflow-hidden">
              <div className="px-3 py-2 bg-paper-50 text-xs font-semibold text-stone-600 border-b border-black/[0.06]">Dados do cliente</div>
              <div className="p-3 space-y-1.5 text-xs">
                {ficha.data.dadosExternos.vendedor && (
                  <div className="flex justify-between gap-3">
                    <span className="text-stone-500 shrink-0">Vendedor <span className="font-mono">#{ficha.data.dadosExternos.vendedor.cod}</span></span>
                    <span className="text-stone-700 text-right">{ficha.data.dadosExternos.vendedor.nome || '—'}{ficha.data.dadosExternos.vendedor.telefone ? ` · ${ficha.data.dadosExternos.vendedor.telefone}` : ''}</span>
                  </div>
                )}
                {ficha.data.dadosExternos.supervisor && (
                  <div className="flex justify-between gap-3">
                    <span className="text-stone-500 shrink-0">Supervisor <span className="font-mono">#{ficha.data.dadosExternos.supervisor.cod}</span></span>
                    <span className="text-stone-700 text-right">{ficha.data.dadosExternos.supervisor.nome || '—'}{ficha.data.dadosExternos.supervisor.telefone ? ` · ${ficha.data.dadosExternos.supervisor.telefone}` : ''}</span>
                  </div>
                )}
                {(ficha.data.dadosExternos.telefonesCliente || []).length > 0 && (
                  <div className="flex justify-between gap-3">
                    <span className="text-stone-500 shrink-0">Telefones do cadastro</span>
                    <span className="text-stone-700 text-right font-mono">{ficha.data.dadosExternos.telefonesCliente.join(' · ')}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Mini-painel de cobrança */}
          {codigoExterno && (
            <div className="rounded-lg border border-black/[0.07] overflow-hidden">
              <div className="px-3 py-2 bg-paper-50 text-xs font-semibold text-stone-600 border-b border-black/[0.06]">Títulos em aberto</div>
              <div className="p-3">
                {cobranca.isLoading ? <p className="text-xs text-stone-400">Carregando…</p>
                  : cobranca.isError ? <p className="text-xs text-amber-700">{cobranca.error.response?.data?.error || 'Sem acesso aos títulos.'}</p>
                  : !cobranca.data?.resumo || cobranca.data.resumo.qtd === 0 ? <p className="text-xs text-emerald-700">Nenhum título vencido em aberto. 🎉</p>
                  : (
                    <>
                      <div className="flex items-baseline gap-3 mb-2">
                        <span className="text-lg font-bold text-red-700">{moedaBR(cobranca.data.resumo.saldo)}</span>
                        <span className="text-xs text-stone-500">{cobranca.data.resumo.qtd} título(s) · mais antigo {dataBR(cobranca.data.resumo.vencAntigo)}</span>
                      </div>
                      <div className="max-h-32 overflow-y-auto text-xs divide-y divide-black/[0.05]">
                        {(cobranca.data.titulos || []).map((t, i) => (
                          <div key={i} className="flex items-center justify-between py-1">
                            <span className="font-mono text-stone-500">{t.duplicata}{t.prestacao ? `/${t.prestacao}` : ''}</span>
                            <span className="text-stone-700">{moedaBR(t.valor)}</span>
                            <span className="text-stone-400">venc {dataBR(t.vencimento)}</span>
                            <span className="text-red-600">{t.diasAtraso}d</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
              </div>
            </div>
          )}

          {ficha.data?.atualizadoPor && (
            <p className="text-[11px] text-stone-400">Editado por {ficha.data.atualizadoPor} em {dataBR(ficha.data.atualizadoEm)}.</p>
          )}
          {erro && <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{erro}</div>}
        </div>

        <div className="modal-footer">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-black/20 text-stone-700 font-semibold text-sm">Cancelar</button>
          <button onClick={() => { setErro(''); salvar.mutate(); }} disabled={salvar.isPending || !pronto}
            className="flex-1 py-2.5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white font-semibold text-sm disabled:opacity-40">
            {salvar.isPending ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Composer({ conversa, onReabrir }) {
  const [texto, setTexto] = useState('');
  const [erro, setErro] = useState('');
  const [modo, setModo] = useState('msg'); // 'msg' | 'nota'
  const [gerenciandoAtalhos, setGerenciandoAtalhos] = useState(false);
  const qc = useQueryClient();
  const arquivoRef = useRef(null);
  const mostraAtalhos = texto.startsWith('/'); // "/" abre os atalhos

  const enviarArquivo = useMutation({
    mutationFn: (file) => {
      const fd = new FormData();
      fd.append('arquivo', file);
      return api.post(`/conversas/${conversa.id}/arquivos`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 120_000, // arquivos grandes
      });
    },
    onSuccess: () => {
      setErro('');
      qc.invalidateQueries({ queryKey: ['mensagens', conversa.id] });
      qc.invalidateQueries({ queryKey: ['conversas'] });
    },
    onError: (err) => setErro(err.response?.data?.error || 'Falha ao enviar o arquivo.'),
  });

  // Liga/desliga em Administração → Agente de IA; cache compartilhado com Ajustes/EncerrarModal.
  const config = useQuery({
    queryKey: ['config'],
    queryFn: () => api.get('/config').then((r) => r.data),
    staleTime: 5 * 60_000,
  });
  const sugestaoLigada = config.data?.ia_sugestao_ativa === 'S';
  const sugerirResposta = useMutation({
    mutationFn: () => api.post(`/conversas/${conversa.id}/sugestao-resposta`).then((r) => r.data),
    onSuccess: (data) => { setErro(''); setTexto(data.sugestao); },
    onError: (err) => setErro(err.response?.data?.error || 'Falha ao gerar sugestão.'),
  });

  const aberta = (janelaRestante(conversa.janelaExpiraEm) ?? 0) > 0;
  const isNota = modo === 'nota';

  const enviar = useMutation({
    mutationFn: (txt) => api.post(
      `/conversas/${conversa.id}/${isNota ? 'notas' : 'mensagens'}`, { texto: txt }
    ),
    onSuccess: () => {
      setTexto('');
      setErro('');
      qc.invalidateQueries({ queryKey: ['mensagens', conversa.id] });
      qc.invalidateQueries({ queryKey: ['conversas'] });
    },
    onError: (err) => {
      setErro(err.response?.data?.error || 'Falha ao enviar. Tente novamente.');
    },
  });

  // Fora da janela só some o campo de TEXTO; a nota interna continua liberada.
  const submit = (e) => {
    e.preventDefault();
    const t = texto.trim();
    if (!t || enviar.isPending) return;
    if (!isNota && !aberta) return; // texto livre exige janela aberta
    enviar.mutate(t);
  };

  const ToggleModo = () => (
    <div className="flex gap-1 mb-2">
      {[['msg', 'Mensagem'], ['nota', 'Nota interna']].map(([m, label]) => (
        <button key={m} type="button" onClick={() => { setModo(m); setErro(''); }}
          className={`text-xs px-2.5 py-1 rounded-full font-medium transition-colors
            ${modo === m
              ? (m === 'nota' ? 'bg-amber-100 text-amber-800' : 'bg-brand-50 text-brand-700')
              : 'text-stone-400 hover:text-stone-600'}`}>
          {label}
        </button>
      ))}
    </div>
  );

  if (!aberta && !isNota) {
    // Dois casos distintos de "sem texto livre":
    //  • nuncaAbriu (JANELA_EXPIRA_EM vazio): disparamos um template e o cliente
    //    ainda não respondeu — a janela nem abriu. O certo é AGUARDAR, não mandar
    //    outro template. Sem botão.
    //  • expirou (JANELA_EXPIRA_EM no passado): o cliente respondeu e passaram 24h.
    //    Aí sim faz sentido reabrir com um template.
    const nuncaAbriu = janelaRestante(conversa.janelaExpiraEm) === null;
    return (
      <div className="shrink-0 bg-white border-t border-black/[0.06] px-3 py-2.5 safe-bottom">
        <ToggleModo />
        {nuncaAbriu ? (
          <div className="text-center text-xs text-stone-500 py-1.5 px-2">
            📤 <span className="font-semibold">Template enviado</span> — aguardando o cliente responder.
            Quando ele responder, a janela de 24h abre e o texto livre é liberado.
            <span className="block text-[11px] text-stone-400 mt-0.5">Precisa anotar algo agora? Use a <span className="font-semibold">nota interna</span>.</span>
          </div>
        ) : (
          <div className="text-center py-1.5 px-2">
            <p className="text-xs text-stone-500">
              🔒 <span className="font-semibold">Janela de 24h fechada</span>
              {onReabrir
                ? ' — para retomar a conversa, reabra com um template.'
                : ' — o cliente precisa enviar uma nova mensagem para reabrir.'}
            </p>
            {onReabrir && (
              <button type="button" onClick={onReabrir}
                className="mt-2 px-4 py-2 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-sm font-semibold">
                Reabrir com template
              </button>
            )}
            <span className="block text-[11px] text-stone-400 mt-1.5">Ou registre uma <span className="font-semibold">nota interna</span>.</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative shrink-0 bg-white border-t border-black/[0.06] px-3 py-2.5 safe-bottom">
      {mostraAtalhos && (
        <AtalhosDropdown
          filtro={texto.slice(1)}
          onEscolher={(a) => setTexto(a.conteudo)}
          onGerenciar={() => setGerenciandoAtalhos(true)}
        />
      )}
      {gerenciandoAtalhos && <AtalhosModal onClose={() => setGerenciandoAtalhos(false)} />}
      {erro && <p className="text-xs text-red-600 mb-1.5 px-1">{erro}</p>}
      <ToggleModo />
      <form onSubmit={submit} className="flex items-end gap-2">
        {!isNota && (
          <>
            <input ref={arquivoRef} type="file" className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) enviarArquivo.mutate(f);
                e.target.value = ''; // permite reenviar o mesmo arquivo
              }} />
            <button type="button" onClick={() => arquivoRef.current?.click()}
              disabled={enviarArquivo.isPending}
              title="Enviar arquivo (imagem, áudio, vídeo, documento — máx. 16MB)"
              className="shrink-0 w-10 h-10 rounded-full text-stone-400 hover:text-brand-700 hover:bg-brand-50
                         flex items-center justify-center transition-colors disabled:opacity-40"
              aria-label="Anexar arquivo">
              {enviarArquivo.isPending ? (
                <span className="w-4 h-4 border-2 border-brand-300 border-t-brand-700 rounded-full animate-spin" />
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                </svg>
              )}
            </button>
            {sugestaoLigada && (
              <button type="button" onClick={() => sugerirResposta.mutate()}
                disabled={sugerirResposta.isPending}
                title="Sugerir resposta com IA — você revisa e edita antes de enviar"
                className="shrink-0 w-10 h-10 rounded-full text-stone-400 hover:text-brand-700 hover:bg-brand-50
                           flex items-center justify-center transition-colors disabled:opacity-40"
                aria-label="Sugerir resposta">
                {sugerirResposta.isPending ? (
                  <span className="w-4 h-4 border-2 border-brand-300 border-t-brand-700 rounded-full animate-spin" />
                ) : (
                  <Icon name="bot" size={19} />
                )}
              </button>
            )}
          </>
        )}
        <textarea
          rows={1}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(e); }
          }}
          placeholder={isNota ? 'Nota interna (não vai pro cliente)…' : 'Digite uma mensagem — "/" para atalhos…'}
          className={`input-field !py-2.5 resize-none max-h-32 ${isNota ? '!bg-amber-50 !border-amber-200' : ''}`}
        />
        <button
          type="submit"
          disabled={!texto.trim() || enviar.isPending}
          className={`shrink-0 w-10 h-10 rounded-full text-white flex items-center justify-center
                     disabled:opacity-40 disabled:cursor-not-allowed transition-colors
                     ${isNota ? 'bg-amber-500 hover:bg-amber-600' : 'bg-brand-700 hover:bg-brand-800'}`}
          aria-label={isNota ? 'Salvar nota' : 'Enviar'}
        >
          {enviar.isPending ? (
            <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
          ) : isNota ? (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="w-5 h-5 -rotate-45 translate-x-px" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          )}
        </button>
      </form>
    </div>
  );
}

// Chip de filtro do inbox (origem/janela/sem-dono). Toggle simples; ativo = preenchido.
function FiltroChip({ ativo, onClick, children }) {
  return (
    <button type="button" onClick={onClick}
      className={`text-[11px] px-2.5 py-1 rounded-full font-medium border transition-colors
        ${ativo
          ? 'bg-brand-700 text-white border-brand-700'
          : 'bg-white text-stone-500 border-black/10 hover:border-stone-300 hover:text-stone-700'}`}>
      {children}
    </button>
  );
}

function AtendimentoRail({ isGestor, suporte, user, secao, onSelect }) {
  const inicial = (user?.nome || user?.email || '?').trim().slice(0, 1).toUpperCase();
  const itens = [
    { id: 'conversas', nome: 'Conversas', icon: 'inbox' },
    ...(!suporte ? [{ id: 'historico', nome: 'Meus atendimentos', icon: 'history' }] : []),
    // FIL-85: só existe com o add-on de IA — sem agente não há pedido nenhum
    // para conferir, e a seção vazia só ocuparia espaço.
    ...(user?.iaHabilitada ? [{ id: 'pedidos', nome: 'Pedidos da IA', icon: 'contract' }] : []),
    { id: 'equipe', nome: 'Equipe online', icon: 'users' },
  ];

  return (
    <aside className="hidden md:flex w-16 shrink-0 bg-ink-950 text-white flex-col items-center border-r border-white/10">
      <Link
        to="/conversas"
        className="h-14 w-full flex items-center justify-center border-b border-white/10"
        aria-label="Olume Chat — conversas"
      >
        <BrandMark inverse className="w-8 h-8" />
      </Link>
      <nav className="flex-1 py-3 flex flex-col items-center gap-1.5" aria-label="Navegação principal">
        {itens.map((item) => {
          const ativo = secao === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item.id)}
              aria-current={ativo ? 'page' : undefined}
              aria-label={item.nome}
              title={item.nome}
              className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                ativo
                  ? 'bg-brand-400 text-ink-950'
                  : 'text-white/60 hover:bg-white/[0.08] hover:text-white'
              }`}
            >
              <Icon name={item.icon} size={18} />
            </button>
          );
        })}
        {(isGestor || suporte || user?.papel === 'AUDITOR') && (
          <Link
            to="/admin"
            title="Gestão"
            className="w-10 h-10 rounded-lg text-white/60 hover:bg-white/[0.08] hover:text-white flex items-center justify-center"
          >
            <Icon name="chart" size={18} />
          </Link>
        )}
        <ThemeMenu align="left" inverse icon="sun" />
      </nav>
      <div className="w-full py-3 border-t border-white/10 flex justify-center">
        <span className="w-8 h-8 rounded-full border border-white/15 bg-white/[0.08] flex items-center justify-center text-[11px] font-semibold">
          {inicial}
        </span>
      </div>
    </aside>
  );
}

function AtendimentoMobileNav({ secao, onSelect, suporte, iaHabilitada }) {
  const itens = [
    { id: 'conversas', nome: 'Conversas', icon: 'inbox' },
    ...(!suporte ? [{ id: 'historico', nome: 'Histórico', icon: 'history' }] : []),
    ...(iaHabilitada ? [{ id: 'pedidos', nome: 'Pedidos', icon: 'contract' }] : []),
    { id: 'equipe', nome: 'Online', icon: 'users' },
  ];
  return (
    <nav className="md:hidden shrink-0 px-3 py-2 bg-white border-b border-paper-300 flex gap-1 overflow-x-auto" aria-label="Seções do atendimento">
      {itens.map((item) => {
        const ativo = secao === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            aria-current={ativo ? 'page' : undefined}
            className={`min-h-9 px-3 rounded-md flex items-center gap-2 text-xs font-semibold ${
              ativo ? 'bg-brand-50 text-brand-800' : 'text-stone-600 hover:bg-paper-100'
            }`}
          >
            <Icon name={item.icon} size={15} />
            {item.nome}
          </button>
        );
      })}
    </nav>
  );
}

const STATUS_HISTORICO = {
  resolvida: { rotulo: 'Finalizado', classe: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  em_atendimento: { rotulo: 'Em atendimento', classe: 'bg-brand-50 text-brand-800 border-brand-200' },
  aguardando: { rotulo: 'Aguardando', classe: 'bg-amber-50 text-amber-800 border-amber-200' },
  ia: { rotulo: 'Agente de IA', classe: 'bg-purple-50 text-purple-700 border-purple-200' },
};

function MeuHistorico() {
  const [busca, setBusca] = useState('');
  const [q, setQ] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setQ(busca.trim()), 300);
    return () => clearTimeout(timer);
  }, [busca]);

  const historico = useQuery({
    queryKey: ['historico', 'me', q],
    queryFn: () => api.get('/historico/me', { params: q ? { q } : {} }).then((response) => response.data),
  });
  const itens = historico.data?.itens || [];

  return (
    <main className="flex-1 min-w-0 overflow-y-auto bg-paper-50">
      <div className="max-w-6xl mx-auto px-4 py-5 md:px-7 md:py-7">
        <div className="page-heading">
          <div>
            <h1 className="page-title">Meus atendimentos</h1>
            <p className="page-description">Consulte apenas as conversas que passaram por você.</p>
          </div>
          <span className="text-xs text-stone-500">{historico.isLoading ? 'Carregando…' : `${itens.length} registros`}</span>
        </div>

        <section className="app-panel overflow-hidden">
          <header className="px-4 py-3 border-b border-paper-300">
            <label className="relative block max-w-md">
              <span className="sr-only">Buscar no meu histórico</span>
              <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-500" />
              <input
                value={busca}
                onChange={(event) => setBusca(event.target.value)}
                placeholder="Buscar cliente, telefone ou protocolo"
                className="input-field !pl-9"
              />
            </label>
          </header>

          {historico.isLoading && <div className="p-10 flex justify-center"><Spinner /></div>}
          {historico.isError && (
            <div className="p-8 text-center">
              <p className="text-sm font-semibold text-red-800">Não foi possível carregar seu histórico.</p>
              <button type="button" onClick={() => historico.refetch()} className="mt-3 text-xs font-semibold text-brand-700">Tentar novamente</button>
            </div>
          )}
          {!historico.isLoading && !historico.isError && itens.length === 0 && (
            <div className="px-6 py-12 text-center">
              <span className="mx-auto w-11 h-11 rounded-lg bg-paper-200 text-stone-500 flex items-center justify-center">
                <Icon name="history" size={20} />
              </span>
              <p className="mt-3 text-sm font-semibold text-ink-950">{q ? 'Nenhum atendimento encontrado' : 'Seu histórico ainda está vazio'}</p>
              <p className="mt-1 text-xs text-stone-600">{q ? 'Tente outro nome, telefone ou protocolo.' : 'Os atendimentos assumidos por você aparecerão aqui.'}</p>
            </div>
          )}
          {itens.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-xs">
                <thead className="bg-paper-50 text-stone-600">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-semibold">Cliente</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Protocolo</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Departamento</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Status</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Última atividade</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-paper-300">
                  {itens.map((item) => {
                    const status = STATUS_HISTORICO[item.filaStatus] || { rotulo: item.filaStatus || '—', classe: 'bg-paper-100 text-stone-700 border-paper-300' };
                    return (
                      <tr key={item.id} className="hover:bg-paper-50">
                        <td className="px-4 py-3">
                          <p className="font-semibold text-ink-950">{item.nomePerfil || formatPhone(item.telefone)}</p>
                          <p className="mt-0.5 text-[10px] text-stone-500">{formatPhone(item.telefone)}</p>
                        </td>
                        <td className="px-4 py-3 font-mono text-stone-700">{item.protocolo || '—'}</td>
                        <td className="px-4 py-3 text-stone-700">{item.departamento || 'Geral'}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex px-2 py-1 rounded-md border text-[10px] font-semibold ${status.classe}`}>{status.rotulo}</span>
                        </td>
                        <td className="px-4 py-3 text-stone-600">{formatDateTime(item.resolvidaEm || item.criadoEm)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function EquipeOnline({ deptos }) {
  const equipe = useQuery({
    queryKey: ['presenca', 'equipe'],
    queryFn: () => api.get('/presenca/equipe').then((response) => response.data),
    refetchInterval: 15_000,
  });
  const departamentos = new Map((deptos.data || []).map((item) => [Number(item.id), item]));
  const pessoas = equipe.data || [];

  return (
    <main className="flex-1 min-w-0 overflow-y-auto bg-paper-50">
      <div className="max-w-5xl mx-auto px-4 py-5 md:px-7 md:py-7">
        <div className="page-heading">
          <div>
            <h1 className="page-title">Equipe online</h1>
            <p className="page-description">Veja quem está disponível agora em todos os departamentos.</p>
          </div>
          <span className="inline-flex items-center gap-2 text-xs font-semibold text-stone-700">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            {equipe.isLoading ? 'Atualizando…' : `${pessoas.length} online`}
          </span>
        </div>

        <section className="app-panel overflow-hidden">
          <header className="panel-header">
            <p className="text-sm font-semibold text-ink-950">Atendentes disponíveis</p>
            <p className="ml-auto text-[10px] text-stone-500">Atualiza a cada 15 segundos</p>
          </header>
          {equipe.isLoading && <div className="p-10 flex justify-center"><Spinner /></div>}
          {equipe.isError && (
            <div className="p-8 text-center">
              <p className="text-sm font-semibold text-red-800">Não foi possível consultar a equipe.</p>
              <button type="button" onClick={() => equipe.refetch()} className="mt-3 text-xs font-semibold text-brand-700">Tentar novamente</button>
            </div>
          )}
          {!equipe.isLoading && !equipe.isError && pessoas.length === 0 && (
            <div className="px-6 py-12 text-center">
              <span className="mx-auto w-11 h-11 rounded-lg bg-paper-200 text-stone-500 flex items-center justify-center">
                <Icon name="users" size={20} />
              </span>
              <p className="mt-3 text-sm font-semibold text-ink-950">Nenhum outro atendente online</p>
              <p className="mt-1 text-xs text-stone-600">A lista será atualizada automaticamente quando alguém entrar.</p>
            </div>
          )}
          {pessoas.length > 0 && (
            <div className="divide-y divide-paper-300">
              {pessoas.map((pessoa) => (
                <div key={pessoa.atendenteId} className="px-4 py-3.5 flex items-center gap-3 hover:bg-paper-50">
                  <span className="relative w-9 h-9 rounded-full bg-ink-900 text-white flex items-center justify-center text-xs font-semibold shrink-0">
                    {iniciais(pessoa.nome, '')}
                    <span className="absolute right-0 bottom-0 w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-white" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-ink-950 truncate">{pessoa.nome || `Atendente #${pessoa.atendenteId}`}</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {(pessoa.deptoIds || []).map((id) => {
                        const departamento = departamentos.get(Number(id));
                        return (
                          <span key={id} className="inline-flex items-center gap-1.5 text-[10px] text-stone-600">
                            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: departamento?.cor || '#1F7A60' }} />
                            {departamento?.nome || `Departamento #${id}`}
                          </span>
                        );
                      })}
                      {(pessoa.deptoIds || []).length === 0 && <span className="text-[10px] text-stone-500">Sem departamento</span>}
                    </div>
                  </div>
                  <span className="text-[10px] font-semibold text-emerald-700">Online</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function PainelContexto({ isGestor, contagens, deptos, conversa, filaAtual }) {
  const porDepartamento = contagens.data?.porDepartamento || {};
  const totalAguardando = Object.values(porDepartamento).reduce((soma, item) => soma + (item.aguardando || 0), 0);
  const totalAtendimento = Object.values(porDepartamento).reduce((soma, item) => soma + (item.em_atendimento || 0), 0);
  const filas = (deptos.data || [])
    .map((departamento) => ({
      ...departamento,
      aguardando: porDepartamento[departamento.id]?.aguardando || 0,
      emAtendimento: porDepartamento[departamento.id]?.em_atendimento || 0,
    }))
    .sort((a, b) => (b.aguardando + b.emAtendimento) - (a.aguardando + a.emAtendimento))
    .slice(0, 5);
  const maiorFila = Math.max(1, ...filas.map((item) => item.aguardando + item.emAtendimento));

  return (
    <aside className="conversation-context hidden xl:flex w-[276px] 2xl:w-[300px] shrink-0 bg-white border-l border-paper-300 flex-col">
      <header className="h-14 px-4 border-b border-paper-300 flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-emerald-500" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-ink-950">{isGestor ? 'Operação ao vivo' : 'Contexto do atendimento'}</p>
          <p className="text-[10px] text-stone-500">{isGestor ? 'Atualização automática' : 'Dados da conversa selecionada'}</p>
        </div>
      </header>

      {isGestor ? (
        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-2 border-b border-paper-300">
            <div className="px-4 py-4 border-r border-paper-300">
              <p className="text-[10px] text-stone-500">Em espera</p>
              <p className="mt-1 text-2xl font-semibold tabular text-ink-950">{contagens.isLoading ? '—' : totalAguardando}</p>
            </div>
            <div className="px-4 py-4">
              <p className="text-[10px] text-stone-500">Em atendimento</p>
              <p className="mt-1 text-2xl font-semibold tabular text-ink-950">{contagens.isLoading ? '—' : totalAtendimento}</p>
            </div>
          </div>
          <div className="px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold text-ink-950">Filas por departamento</p>
              <Link to="/admin" className="text-[10px] font-semibold text-brand-700 hover:text-brand-800">Ver gestão</Link>
            </div>
            <div className="mt-4 space-y-4">
              {filas.map((item) => {
                const volume = item.aguardando + item.emAtendimento;
                return (
                  <div key={item.id}>
                    <div className="flex items-center justify-between gap-2 text-[10px]">
                      <span className="truncate text-stone-700">{item.nome}</span>
                      <span className="font-semibold tabular text-stone-600">{volume}</span>
                    </div>
                    <div className="mt-1.5 h-1 rounded-full bg-paper-200 overflow-hidden">
                      <span
                        className="block h-full rounded-full bg-brand-700"
                        style={{ width: `${Math.max(8, (volume / maiorFila) * 100)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
              {!contagens.isLoading && filas.length === 0 && (
                <p className="text-xs leading-relaxed text-stone-600">Configure departamentos para acompanhar a distribuição das filas.</p>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {conversa ? (
            <div className="space-y-5">
              <div>
                <p className="text-[10px] font-semibold text-stone-500">CLIENTE</p>
                <p className="mt-1 text-sm font-semibold text-ink-950">{conversa.nomeInterno || conversa.nomePerfil || formatPhone(conversa.telefone)}</p>
                <p className="mt-0.5 text-xs text-stone-600">{formatPhone(conversa.telefone)}</p>
              </div>
              <div className="grid grid-cols-2 border-y border-paper-300">
                <div className="py-3 border-r border-paper-300">
                  <p className="text-[10px] text-stone-500">Protocolo</p>
                  <p className="mt-1 text-xs font-mono font-semibold text-ink-950">{conversa.protocolo || '—'}</p>
                </div>
                <div className="py-3 pl-3">
                  <p className="text-[10px] text-stone-500">Origem</p>
                  <p className="mt-1 text-xs font-semibold text-ink-950">{conversa.origem === 'ativa' ? 'Ativa' : 'Receptiva'}</p>
                </div>
              </div>
              <div>
                <p className="text-[10px] font-semibold text-stone-500">RESPONSABILIDADE</p>
                <div className="mt-2 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: conversa.departamentoCor || '#1F7A60' }} />
                  <span className="text-xs text-stone-700">{conversa.departamentoNome || 'Geral'}</span>
                </div>
                <p className="mt-2 text-xs text-stone-600">{conversa.atendenteNome || 'Ainda sem atendente responsável'}</p>
              </div>
            </div>
          ) : (
            <div className="py-8">
              <span className="w-10 h-10 rounded-lg bg-paper-200 text-stone-500 flex items-center justify-center">
                <Icon name="inbox" size={18} />
              </span>
              <p className="mt-3 text-sm font-semibold text-ink-950">Nenhuma conversa aberta</p>
              <p className="mt-1 text-xs leading-relaxed text-stone-600">Selecione um atendimento para consultar protocolo, origem e responsabilidade.</p>
              <p className="mt-5 text-[10px] text-stone-500">Nesta fila</p>
              <p className="mt-1 text-2xl font-semibold tabular text-ink-950">{filaAtual}</p>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

export default function Conversas() {
  const [secao, setSecao] = useState('conversas');
  const [sel, setSel] = useState(null);
  const [nova, setNova] = useState(false);
  const [reabrir, setReabrir] = useState(false); // reabrir conversa (janela 24h expirou) via template
  const [busca, setBusca] = useState('');
  const [q, setQ] = useState('');
  const [aba, setAba] = useState('aguardando');
  const [depto, setDepto] = useState(''); // filtro por departamento (vazio = todos)
  const [origem, setOrigem] = useState('');   // '' | 'ativa' | 'receptiva'
  const [janela, setJanela] = useState('');   // '' | 'aberta' | 'fechada'
  const [canal, setCanal] = useState('');     // '' | numeroId (filtro de canal)
  const [transferindo, setTransferindo] = useState(false);
  const [encerrando, setEncerrando] = useState(false);
  const [editandoContato, setEditandoContato] = useState(false);
  const [vendoPedidos, setVendoPedidos] = useState(false);
  const { user, isGestor } = useAuth();
  const qc = useQueryClient();

  // Aba "Bot (IA)" só para gestor: as conversas do bot são gestor/diretor ↔ IA.
  // Atendente comum não vê a aba (e assim nunca consulta fila=ia).
  const abasFila = isGestor
    ? [...ABAS_FILA, { id: 'ia', rotulo: 'Bot (IA)', params: { fila: 'ia' } }]
    : ABAS_FILA;

  // Departamentos para o filtro (só aparece pra quem vê mais de um).
  const deptos = useQuery({
    queryKey: ['departamentos'],
    queryFn: () => api.get('/departamentos').then((r) => r.data),
    staleTime: 5 * 60_000,
  });

  const contagens = useQuery({
    queryKey: ['conversas', 'contagens'],
    queryFn: () => api.get('/conversas/contagens').then((r) => r.data),
    enabled: isGestor,
    refetchInterval: 30_000,
  });

  // Canais (números) para o filtro — lista enxuta, acessível a qualquer atendente.
  const numerosLista = useQuery({
    queryKey: ['numeros-lista'],
    queryFn: () => api.get('/numeros/lista').then((r) => r.data),
    staleTime: 5 * 60_000,
  });

  // Debounce da busca (evita uma chamada por tecla).
  useEffect(() => {
    const t = setTimeout(() => setQ(busca.trim()), 350);
    return () => clearTimeout(t);
  }, [busca]);

  // Opções do filtro: ADMIN/AUDITOR veem todos os departamentos; os demais só os
  // seus (mesmo escopo do backend). O filtro só aparece pra quem tem 2+ deptos.
  const verTudo = user?.papel === 'ADMIN' || user?.papel === 'AUDITOR';
  const deptoOpcoes = (deptos.data || []).filter((d) => verTudo || (user?.deptoIds || []).includes(d.id));

  // Se o departamento filtrado sair das opções (ex.: desativado por um admin),
  // limpa o filtro — senão a lista fica presa num filtro que o select já não mostra.
  useEffect(() => {
    if (depto && deptos.data && !deptoOpcoes.some((d) => String(d.id) === String(depto))) {
      setDepto('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depto, deptos.data]);

  // Mesma proteção pro canal: se o número filtrado sai da lista (desativado /
  // fora do escopo), zera o filtro pra não filtrar a inbox silenciosamente.
  useEffect(() => {
    if (canal && numerosLista.data && !numerosLista.data.some((n) => String(n.id) === String(canal))) {
      setCanal('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canal, numerosLista.data]);

  const abaDef = abasFila.find((a) => a.id === aba) || abasFila[0];
  const conversas = useQuery({
    queryKey: ['conversas', q, aba, depto, origem, janela, canal],
    queryFn: () => api.get('/conversas', {
      params: {
        ...(q ? { q } : {}),
        ...abaDef.params,
        ...(depto ? { departamentoId: depto } : {}),
        ...(origem ? { origem } : {}),
        ...(janela ? { janela } : {}),
        ...(canal ? { numeroId: canal } : {}),
      },
    }).then((r) => r.data),
    refetchInterval: 60000, // fallback; o tempo-real vem do SSE
  });

  const mensagens = useQuery({
    queryKey: ['mensagens', sel?.id],
    queryFn: () => api.get(`/conversas/${sel.id}/mensagens`).then((r) => r.data),
    enabled: !!sel,
    refetchInterval: 60000, // fallback; o tempo-real vem do SSE
  });

  // FIL-85 — pedidos EM RASCUNHO desta conversa: é o atalho a partir do
  // atendimento (a lista completa mora na seção "Pedidos da IA"). A queryKey
  // fica sob o prefixo ['ia-pedidos'] para a invalidação do SSE pegar os dois,
  // mas com um segmento PRÓPRIO ('badge'): o PedidosIa é uma infinite query, e
  // duas queries de tipos diferentes na mesma chave brigariam pelo cache.
  const pedidosDaConversa = useQuery({
    queryKey: ['ia-pedidos', 'badge', sel?.id],
    queryFn: () => api.get('/ia-pedidos', {
      params: { status: 'rascunho', conversaId: sel.id, limite: 20 },
    }).then((r) => r.data),
    enabled: !!sel?.id && !!user?.iaHabilitada,
  });
  const rascunhosDaConversa = pedidosDaConversa.data?.itens?.length || 0;

  // Tempo-real: eventos do SSE (mensagem/status/fila/atribuicao/transferencia).
  useEventStream((evt) => {
    qc.invalidateQueries({ queryKey: ['conversas'] });
    // Pedido registrado pela IA (ou conferido por um colega) — o badge e a
    // lista têm que mudar na hora, não no refetch de 60s.
    if (evt.tipo === 'pedido') qc.invalidateQueries({ queryKey: ['ia-pedidos'] });
    if (isGestor) qc.invalidateQueries({ queryKey: ['conversas', 'contagens'] });
    if (sel && evt.conversaId === sel.id) {
      qc.invalidateQueries({ queryKey: ['mensagens', sel.id] });
    }
    // Conversa nova na fila ou atribuída a mim → bip de aviso.
    if (evt.tipo === 'fila' || evt.tipo === 'atribuicao') tocarBip();
  });

  const assumir = useMutation({
    mutationFn: (id) => api.post(`/conversas/${id}/atribuir`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['conversas'] }),
  });

  // FIL-84 — handoff nos dois sentidos. Rotas separadas do /atribuir: sair da
  // IA precisa da guarda de fila_status='ia' (corrida com a própria IA
  // transferindo) e resolve o departamento pela cascata do canal.
  const assumirIa = useMutation({
    mutationFn: (id) => api.post(`/conversas/${id}/assumir-ia`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversas'] });
      if (sel) qc.invalidateQueries({ queryKey: ['mensagens', sel.id] });
    },
  });
  const devolverIa = useMutation({
    mutationFn: (id) => api.post(`/conversas/${id}/devolver-ia`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversas'] });
      if (sel) qc.invalidateQueries({ queryKey: ['mensagens', sel.id] });
    },
  });

  // Mantém a conversa selecionada em sincronia com a lista (tags/última msg).
  useEffect(() => {
    if (!sel || !conversas.data) return;
    const fresh = conversas.data.find((c) => c.id === sel.id);
    if (fresh) setSel(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversas.data]);

  return (
    <div className="conversation-shell flex bg-paper-100" style={{ height: '100dvh' }}>
      <AtendimentoRail
        isGestor={isGestor}
        suporte={user?.suporte}
        user={user}
        secao={secao}
        onSelect={(novaSecao) => {
          setSecao(novaSecao);
          setSel(null);
        }}
      />
      <div className="flex-1 min-w-0 flex flex-col">
        <Header
          title={secao === 'historico' ? 'Meus atendimentos'
            : secao === 'equipe' ? 'Equipe online'
              : secao === 'pedidos' ? 'Pedidos da IA' : 'Conversas'}
          embedded
        />
        {!(secao === 'conversas' && sel) && (
          <AtendimentoMobileNav suporte={user?.suporte} iaHabilitada={user?.iaHabilitada}
            secao={secao} onSelect={(novaSecao) => { setSecao(novaSecao); setSel(null); }} />
        )}
        <div className="flex-1 min-h-0 flex">
        {secao === 'conversas' ? (
          <>
        {/* Lista */}
        <aside className={`conversation-list w-full md:w-[348px] 2xl:w-[372px] md:border-r border-paper-300 bg-white flex flex-col
          ${sel ? 'hidden md:flex' : 'flex'}`}>
          <div className="shrink-0 px-3.5 py-3 border-b border-paper-300 bg-white space-y-2.5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-ink-950">Conversas</h2>
                <p className="text-[10px] text-stone-500">Fila de atendimento</p>
              </div>
            {user?.podeAtivo && (
              <button onClick={() => setNova(true)}
                className="min-h-8 px-2.5 rounded-md bg-brand-700 hover:bg-brand-800 text-white text-[11px] font-semibold flex items-center justify-center gap-1">
                <Icon name="plus" size={14} />
                Nova
              </button>
            )}
            </div>
            <div className="relative">
              <Icon name="search" size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-500" />
              <input value={busca} onChange={(e) => setBusca(e.target.value)}
                placeholder="Buscar nome, telefone, código ou protocolo…"
                className="w-full min-h-9 pl-8 pr-3 text-xs rounded-md bg-paper-50 border border-paper-400 text-stone-900 placeholder:text-stone-500 outline-none focus:border-brand-700 focus:ring-2 focus:ring-brand-100" />
            </div>
            <div className="flex gap-1 bg-stone-100 rounded-lg p-0.5">
              {abasFila.map((a) => (
                <button key={a.id} onClick={() => { setAba(a.id); setSel(null); }}
                  className={`flex-1 py-1 text-[11px] rounded-md font-medium transition-colors
                    ${aba === a.id ? 'bg-white text-brand-700 shadow-sm' : 'text-stone-500 hover:text-stone-700'}`}>
                  {a.rotulo}
                </button>
              ))}
            </div>
            {deptoOpcoes.length > 1 && (
              <select value={depto} onChange={(e) => { setDepto(e.target.value); setSel(null); }}
                className="w-full min-h-9 px-2.5 text-xs rounded-md bg-paper-50 border border-paper-400 outline-none focus:border-brand-700 text-stone-700"
                aria-label="Filtrar por departamento">
                <option value="">Todos os departamentos</option>
                {deptoOpcoes.map((d) => <option key={d.id} value={d.id}>{d.nome}</option>)}
              </select>
            )}
            {numerosLista.data?.length > 1 && (
              <select value={canal} onChange={(e) => setCanal(e.target.value)}
                className="w-full min-h-9 px-2.5 text-xs rounded-md bg-paper-50 border border-paper-400 outline-none focus:border-brand-700 text-stone-700"
                aria-label="Filtrar por canal">
                <option value="">Todos os canais</option>
                {numerosLista.data.map((n) => (
                  <option key={n.id} value={n.id}>{n.nomeExibicao || formatPhone(n.displayPhone) || `Número #${n.id}`}</option>
                ))}
              </select>
            )}
            <div className="flex flex-wrap gap-1">
              <FiltroChip ativo={origem === 'ativa'} onClick={() => setOrigem((o) => (o === 'ativa' ? '' : 'ativa'))}>Ativas</FiltroChip>
              <FiltroChip ativo={origem === 'receptiva'} onClick={() => setOrigem((o) => (o === 'receptiva' ? '' : 'receptiva'))}>Receptivas</FiltroChip>
              <FiltroChip ativo={janela === 'aberta'} onClick={() => setJanela((j) => (j === 'aberta' ? '' : 'aberta'))}>Janela aberta</FiltroChip>
              <FiltroChip ativo={janela === 'fechada'} onClick={() => setJanela((j) => (j === 'fechada' ? '' : 'fechada'))}>Janela fechada</FiltroChip>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {conversas.isLoading && <div className="p-8 flex justify-center"><Spinner /></div>}
            {conversas.isError && <p className="p-4 text-sm text-red-600">Erro ao carregar conversas.</p>}
            {conversas.data?.length === 0 && (
              <div className="px-6 py-12 text-center">
                <span className="mx-auto w-10 h-10 rounded-xl bg-paper-200 text-stone-500 flex items-center justify-center">
                  <Icon name="inbox" size={19} />
                </span>
                <p className="mt-3 text-sm font-semibold text-ink-950">Nenhuma conversa nesta fila</p>
                <p className="mt-1 text-xs leading-relaxed text-stone-600">Novas mensagens aparecem aqui automaticamente. Você também pode revisar os filtros acima.</p>
              </div>
            )}
            {conversas.data?.map((c) => (
              <ConversaItem key={c.id} c={c} ativo={sel?.id === c.id} onClick={() => setSel(c)} />
            ))}
          </div>
        </aside>

        {/* Thread */}
        <section className={`conversation-thread flex-1 min-w-0 flex-col bg-paper-100 ${sel ? 'flex' : 'hidden md:flex'}`}>
          {!sel ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
              <span className="w-12 h-12 rounded-xl bg-white border border-paper-300 text-stone-500 flex items-center justify-center">
                <Icon name="inbox" size={22} />
              </span>
              <p className="mt-4 text-sm font-semibold text-ink-950">Selecione uma conversa</p>
              <p className="mt-1 max-w-sm text-xs leading-relaxed text-stone-600">Escolha um atendimento na lista para ver o histórico, responder e acessar as ações do contato.</p>
            </div>
          ) : (
            <>
              <div className="h-14 shrink-0 bg-white border-b border-paper-300 flex items-center gap-2 px-3.5">
                <button onClick={() => setSel(null)} className="md:hidden p-1 -ml-1 text-stone-500" aria-label="Voltar">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <div className="min-w-0">
                  <span className="font-semibold text-sm text-stone-800 truncate block">
                    {sel.nomeInterno || sel.nomePerfil || formatPhone(sel.telefone)}
                  </span>
                  <span className="flex items-center gap-1.5 leading-none">
                    <span className={`text-[9px] font-mono uppercase px-1 py-0.5 rounded shrink-0
                      ${sel.origem === 'ativa' ? 'bg-bordeaux-700/10 text-bordeaux-700' : 'bg-emerald-100 text-emerald-700'}`}>
                      {sel.origem === 'ativa' ? 'ativa' : 'receptiva'}
                    </span>
                    {/* Secundários só a partir de sm: no celular espremiam o header e
                        sobrepunham os ícones de ação. */}
                    <span className="hidden sm:flex items-center gap-1.5 min-w-0">
                      {sel.nomeInterno && sel.nomePerfil && sel.nomeInterno !== sel.nomePerfil && (
                        <span className="text-[10px] text-stone-400 truncate" title="Nome no WhatsApp">{sel.nomePerfil}</span>
                      )}
                      {sel.protocolo && (
                        <span className="text-[10px] font-mono text-stone-400 shrink-0">protocolo {sel.protocolo}</span>
                      )}
                      {sel.departamentoNome && <DeptoBadge nome={sel.departamentoNome} cor={sel.departamentoCor} />}
                      <NumeroBadge nome={sel.numeroNome} fone={sel.numeroFone} />
                    </span>
                  </span>
                </div>
                <div className="flex-1" />
                {sel.contatoId && (
                  <button onClick={() => setEditandoContato(true)} title="Editar contato (nome, CNPJ, cliente, observações)"
                    className="p-1.5 rounded-lg text-stone-400 hover:text-brand-700 hover:bg-brand-50" aria-label="Editar contato">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                  </button>
                )}
                {rascunhosDaConversa > 0 && (
                  <button onClick={() => setVendoPedidos(true)}
                    title="Pedidos registrados pela IA nesta conversa, aguardando conferência"
                    className="relative p-1.5 rounded-lg text-amber-700 hover:bg-amber-50" aria-label="Pedidos a conferir">
                    <Icon name="contract" size={19} />
                    <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold flex items-center justify-center">
                      {rascunhosDaConversa}
                    </span>
                  </button>
                )}
                <TagsConversa conversaId={sel.id} tags={sel.tags || []} />
                <JanelaBadge expiraIso={sel.janelaExpiraEm} />
                {sel.filaStatus !== 'resolvida' && sel.filaStatus !== 'ia' && (
                  <>
                    {/* FIL-84: só faz sentido em canal com a IA ligada — devolver
                        num canal sem IA deixaria a conversa presa sem ninguém. */}
                    {sel.numeroModo === 'ia' && (
                      <button onClick={() => devolverIa.mutate(sel.id, { onSuccess: () => setSel({ ...sel, filaStatus: 'ia' }) })}
                        disabled={devolverIa.isPending}
                        title="Devolver o atendimento para o agente de IA"
                        className="p-1.5 rounded-lg text-stone-400 hover:text-brand-700 hover:bg-brand-50 disabled:opacity-40"
                        aria-label="Devolver para a IA">
                        <Icon name="bot" size={19} />
                      </button>
                    )}
                    <button onClick={() => setTransferindo(true)} title="Transferir"
                      className="p-1.5 rounded-lg text-stone-400 hover:text-brand-700 hover:bg-brand-50" aria-label="Transferir">
                      <svg className="w-4.5 h-4.5 w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                      </svg>
                    </button>
                    <button onClick={() => setEncerrando(true)} title="Encerrar atendimento"
                      className="p-1.5 rounded-lg text-red-700 hover:bg-red-50" aria-label="Encerrar">
                      <svg className="w-4.5 h-4.5 w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    </button>
                  </>
                )}
              </div>
              <div className="conversation-messages flex-1 overflow-y-auto px-4 md:px-6 py-4">
                {mensagens.isLoading && <div className="p-8 flex justify-center"><Spinner /></div>}
                {mensagens.data?.length === 0 && <p className="text-center text-sm text-stone-400 mt-8">Sem mensagens.</p>}
                {mensagens.data?.map((m, i) => (
                  <Fragment key={m.id}>
                    {diaMudou(m.ts, mensagens.data[i - 1]?.ts) && <DiaSeparador label={formatDiaSeparador(m.ts)} />}
                    <Bolha m={m} />
                  </Fragment>
                ))}
              </div>
              {(assumirIa.isError || devolverIa.isError) && (
                <p className="shrink-0 px-4 py-2 text-xs text-red-700 bg-red-50 border-t border-red-200">
                  {(assumirIa.error || devolverIa.error)?.response?.data?.error || 'Falha na ação.'}
                </p>
              )}
              {sel.filaStatus === 'ia' ? (
                <div className="shrink-0 bg-brand-50 border-t border-brand-100 px-4 py-3 flex items-center gap-3 safe-bottom">
                  <Icon name="bot" size={15} className="shrink-0 text-brand-800" />
                  <p className="text-xs text-brand-800 flex-1">
                    Conversa conduzida pelo <b>agente de IA</b>. Assuma para responder você — a IA cala na hora.
                  </p>
                  <button
                    onClick={() => assumirIa.mutate(sel.id, { onSuccess: () => setSel({ ...sel, filaStatus: 'em_atendimento' }) })}
                    disabled={assumirIa.isPending}
                    className="shrink-0 px-4 py-2 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-sm font-semibold disabled:opacity-40">
                    {assumirIa.isPending ? 'Assumindo…' : 'Assumir'}
                  </button>
                </div>
              ) : sel.filaStatus === 'aguardando' ? (
                <div className="shrink-0 bg-amber-50 border-t border-amber-200 px-4 py-3 flex items-center gap-3 safe-bottom">
                  <p className="text-xs text-amber-800 flex-1">Conversa aguardando na fila — assuma para responder.</p>
                  <button onClick={() => assumir.mutate(sel.id, { onSuccess: () => setSel({ ...sel, filaStatus: 'em_atendimento' }) })}
                    disabled={assumir.isPending}
                    className="px-4 py-2 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-sm font-semibold disabled:opacity-40">
                    {assumir.isPending ? 'Assumindo…' : 'Assumir conversa'}
                  </button>
                </div>
              ) : sel.filaStatus === 'resolvida' ? (
                <div className="shrink-0 bg-stone-100 border-t border-black/[0.06] px-4 py-3 text-center text-xs text-stone-500 safe-bottom">
                  ✅ Atendimento encerrado{sel.protocolo ? ` — protocolo ${sel.protocolo}` : ''}. Nova mensagem do cliente abre um novo atendimento.
                </div>
              ) : (
                <Composer conversa={sel} onReabrir={user?.podeAtivo ? () => setReabrir(true) : undefined} />
              )}
            </>
          )}
        </section>
        <PainelContexto
          isGestor={isGestor}
          contagens={contagens}
          deptos={deptos}
          conversa={sel}
          filaAtual={conversas.data?.length || 0}
        />
          </>
        ) : secao === 'historico' ? (
          <MeuHistorico />
        ) : secao === 'pedidos' ? (
          <div className="flex-1 min-h-0 overflow-y-auto bg-paper-100">
            <div className="max-w-screen-sm mx-auto p-4 space-y-3">
              <div>
                <h2 className="text-sm font-semibold text-ink-950">Pedidos registrados pela IA</h2>
                <p className="text-[11px] text-stone-500">
                  Confira o que o agente anotou durante o atendimento. Nada é enviado a outro sistema.
                </p>
              </div>
              <PedidosIa />
            </div>
          </div>
        ) : (
          <EquipeOnline deptos={deptos} />
        )}
        </div>

      {transferindo && sel && (
        <TransferirModal conversa={sel}
          onClose={() => setTransferindo(false)}
          onDone={() => { setTransferindo(false); setSel(null); qc.invalidateQueries({ queryKey: ['conversas'] }); }} />
      )}
      {encerrando && sel && (
        <EncerrarModal conversa={sel}
          onClose={() => setEncerrando(false)}
          onDone={() => { setEncerrando(false); setSel(null); qc.invalidateQueries({ queryKey: ['conversas'] }); }} />
      )}
      {vendoPedidos && sel && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/60" onClick={() => setVendoPedidos(false)} />
          <div className="relative w-full sm:max-w-lg bg-white rounded-t-2xl sm:rounded-2xl overflow-hidden">
            <div className="navy-gradient text-white px-4 py-3 flex items-center gap-2">
              <span className="section-bar" />
              <h2 className="font-display font-bold text-base flex-1">Pedidos desta conversa</h2>
              <button onClick={() => setVendoPedidos(false)} className="text-white/70 hover:text-white" aria-label="Fechar">✕</button>
            </div>
            <div className="modal-body max-h-[70vh] overflow-y-auto">
              <PedidosIa conversaId={sel.id} />
            </div>
          </div>
        </div>
      )}

      {editandoContato && sel && sel.contatoId && (
        <ContatoModal conversa={sel}
          onClose={() => setEditandoContato(false)}
          onDone={(patch) => { setEditandoContato(false); setSel((s) => s && { ...s, ...patch }); qc.invalidateQueries({ queryKey: ['conversas'] }); }} />
      )}

      {nova && (
        <NovaConversa
          onClose={() => setNova(false)}
          onCreated={(id) => {
            setNova(false);
            qc.invalidateQueries({ queryKey: ['conversas'] });
            setSel({ id, nomePerfil: null, telefone: '', janelaExpiraEm: null });
          }}
        />
      )}
      {reabrir && sel && (
        <NovaConversa
          contatoInicial={{
            telefone: sel.telefone,
            codigoExterno: sel.codigoExterno,
            nome: sel.nomeInterno || sel.nomePerfil,
          }}
          onClose={() => setReabrir(false)}
          onCreated={() => {
            setReabrir(false);
            qc.invalidateQueries({ queryKey: ['conversas'] });
            qc.invalidateQueries({ queryKey: ['mensagens', sel.id] });
          }}
        />
      )}
      </div>
    </div>
  );
}
