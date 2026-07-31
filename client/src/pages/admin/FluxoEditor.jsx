import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '../../services/api';
import Spinner from '../../components/ui/Spinner';
import { formatPhone } from '../../utils/formatters';

// Identidade visual por tipo de passo (cor do nó na timeline + chip) — paleta
// categórica interna do editor de fluxo, não é o estado semântico do produto
// (mensagem/transferir coincidem com primary/danger por associação intuitiva
// verde=segue, vermelho=encerra, não por serem os tokens). Auditoria FIL-104:
// 'menu' (#B7791F) com texto branco no hover dá 3.64:1, abaixo de AA — achado
// correlato registrado fora do escopo deste ticket, ver PR.
const TIPOS = [
  { id: 'mensagem', rotulo: 'Mensagem', icone: '💬', cor: '#1F7A60', desc: 'Envia um texto e segue pro próximo passo' },
  { id: 'menu', rotulo: 'Menu', icone: '🔢', cor: '#B7791F', desc: 'Cliente escolhe digitando o número' },
  { id: 'pergunta', rotulo: 'Pergunta', icone: '❓', cor: '#5B4B8A', desc: 'Captura uma resposta (ex.: código RCA)' },
  { id: 'consulta', rotulo: 'Consulta BD', icone: '🗄️', cor: '#0E7490', desc: 'Valida a resposta no banco (SELECT) e segue por encontrado/não encontrado' },
  { id: 'irfluxo', rotulo: 'Ir para fluxo', icone: '🔗', cor: '#7C3AED', desc: 'Continua o atendimento em OUTRO fluxo (variáveis preservadas)' },
  { id: 'transferir', rotulo: 'Transferir', icone: '👤', cor: '#2F7D4F', desc: 'Encaminha pra fila de um departamento' },
  { id: 'encerrar', rotulo: 'Encerrar', icone: '🏁', cor: '#C83C4A', desc: 'Finaliza o atendimento' },
];
const tipoDe = (id) => TIPOS.find((t) => t.id === id) || TIPOS[0];

const DEF_VAZIA = {
  versao: 1,
  config: {
    inicio: 'saudacao',
    timeoutMin: 30,
    acaoTimeout: { tipo: 'encerrar', texto: 'Atendimento encerrado por inatividade. Protocolo {{protocolo}}.' },
    msgOpcaoInvalida: 'Opção inválida. Digite apenas o número de uma das opções. 👇',
    maxInvalidas: 3,
    acaoMaxInvalidas: { tipo: 'encerrar', texto: 'Não consegui entender. Encerrando — chame de novo quando precisar!' },
  },
  nos: [
    { id: 'saudacao', tipo: 'mensagem',
      texto: 'Olá, {{nome}}! Seja bem-vindo ao nosso atendimento.\n\nSeu protocolo é: {{protocolo}}',
      proximo: '' },
  ],
};

function Rotulo({ children }) {
  return <label className="block font-mono text-[10px] uppercase tracking-widest text-stone-400 mb-1">{children}</label>;
}

function SelectProximo({ rotulo = 'Próximo passo', valor, onChange, nos, excluirId }) {
  return (
    <div>
      <Rotulo>{rotulo}</Rotulo>
      <select className="input-field !py-2 !text-sm" value={valor || ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">— selecione —</option>
        {nos.filter((n) => n.id !== excluirId).map((n) => (
          <option key={n.id} value={n.id}>{tipoDe(n.tipo).icone} {n.id}</option>
        ))}
      </select>
    </div>
  );
}

export default function FluxoEditor({ fluxoId, onClose, onSaved }) {
  const [nome, setNome] = useState('');
  const [numeroId, setNumeroId] = useState('');
  const [def, setDef] = useState(DEF_VAZIA);
  const [carregando, setCarregando] = useState(!!fluxoId);
  const [erros, setErros] = useState([]);
  const [salvando, setSalvando] = useState(false);
  const [configAberta, setConfigAberta] = useState(false);

  // Preview (simulador)
  const [chat, setChat] = useState([]);
  const [estadoSim, setEstadoSim] = useState(null);
  const [entrada, setEntrada] = useState('');
  const [simAtivo, setSimAtivo] = useState(false);
  const chatRef = useRef(null);

  const empresa = localStorage.getItem('empresa') || 'Sua empresa';

  const numeros = useQuery({ queryKey: ['numeros'], queryFn: () => api.get('/numeros').then((r) => r.data) });
  const fluxosLista = useQuery({ queryKey: ['fluxos'], queryFn: () => api.get('/fluxos').then((r) => r.data) });
  const deptos = useQuery({ queryKey: ['departamentos'], queryFn: () => api.get('/departamentos').then((r) => r.data) });

  useEffect(() => {
    if (!fluxoId) return;
    api.get(`/fluxos/${fluxoId}`).then(({ data }) => {
      setNome(data.nome);
      setNumeroId(data.numeroId || '');
      setDef(data.definicao);
      setCarregando(false);
    }).catch(() => setCarregando(false));
  }, [fluxoId]);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [chat]);

  const nos = def.nos || [];
  const setNo = (idx, patch) => setDef((d) => {
    const novos = [...d.nos];
    novos[idx] = { ...novos[idx], ...patch };
    return { ...d, nos: novos };
  });
  const setCfg = (patch) => setDef((d) => ({ ...d, config: { ...d.config, ...patch } }));

  const addNo = (tipo) => setDef((d) => {
    let n = 1;
    while (d.nos.some((x) => x.id === `${tipo}_${n}`)) n++;
    const novo = { id: `${tipo}_${n}`, tipo, texto: '' };
    if (tipo === 'menu') novo.opcoes = [{ valor: '1', rotulo: '', proximo: '' }];
    if (tipo === 'pergunta') { novo.variavel = ''; novo.validacao = 'texto'; novo.proximo = ''; }
    if (tipo === 'mensagem') novo.proximo = '';
    if (tipo === 'transferir') novo.departamentoId = '';
    if (tipo === 'consulta') { delete novo.texto; novo.sql = ''; novo.seEncontrado = ''; novo.seNaoEncontrado = ''; }
    if (tipo === 'boleto') { delete novo.texto; novo.proximo = ''; novo.seNaoEncontrado = ''; }
    if (tipo === 'irfluxo') novo.fluxo = '';
    return { ...d, nos: [...d.nos, novo] };
  });

  const removerNo = (idx) => setDef((d) => ({ ...d, nos: d.nos.filter((_, i) => i !== idx) }));

  // Reordena o passo na timeline (só visual/organização — o fluxo segue os links).
  const moverNo = (idx, delta) => setDef((d) => {
    const alvo = idx + delta;
    if (alvo < 0 || alvo >= d.nos.length) return d;
    const novos = [...d.nos];
    [novos[idx], novos[alvo]] = [novos[alvo], novos[idx]];
    return { ...d, nos: novos };
  });

  // Reordena uma opção dentro do menu (muda só a posição na lista de roteamento;
  // lembre de ajustar o TEXTO do menu se a numeração mudar).
  const moverOpcao = (idx, oi, delta) => setDef((d) => {
    const novos = [...d.nos];
    const ops = [...(novos[idx].opcoes || [])];
    const alvo = oi + delta;
    if (alvo < 0 || alvo >= ops.length) return d;
    [ops[oi], ops[alvo]] = [ops[alvo], ops[oi]];
    novos[idx] = { ...novos[idx], opcoes: ops };
    return { ...d, nos: novos };
  });

  // ---- simulador ----
  async function simular(texto) {
    try {
      const { data } = await api.post('/fluxos/simular', { definicao: def, estado: estadoSim, texto });
      if (texto !== undefined) setChat((c) => [...c, { de: 'cliente', txt: texto }]);
      for (const q of data.consultas || []) {
        setChat((c) => [...c, { de: 'sys', erro: !!q.erro,
          txt: q.erro ? `consulta ${q.no} — ERRO NO BANCO: ${q.erro}` : `consulta ${q.no}: ${q.encontrado ? '✓ encontrado' : '✗ não encontrado'}` }]);
      }
      setChat((c) => [...c, ...data.mensagens.map((m) => ({ de: 'bot', txt: m }))]);
      if (data.irFluxo) {
        setChat((c) => [...c, { de: 'sys', txt: `→ continua no fluxo "${data.irFluxo}" — teste-o separadamente` }]);
        setSimAtivo(false);
      }
      setEstadoSim(data.estado);
      if (data.acao) {
        const dep = (deptos.data || []).find((d) => d.id === data.acao.departamentoId);
        const fim = data.acao.tipo === 'transferir'
          ? `➡ transferido para a fila: ${dep ? dep.nome : `depto #${data.acao.departamentoId}`}`
          : '✓ atendimento encerrado pelo bot';
        setChat((c) => [...c, { de: 'sys', txt: fim }]);
        setSimAtivo(false);
      }
      setErros([]);
    } catch (e) {
      setErros(e.response?.data?.detalhes || [e.response?.data?.error || 'Erro na simulação.']);
    }
  }
  function iniciarSim() {
    setChat([]); setEstadoSim(null); setSimAtivo(true);
    setTimeout(() => simularInicio(), 0);
  }
  async function simularInicio() {
    try {
      const { data } = await api.post('/fluxos/simular', { definicao: def });
      const sys = (data.consultas || []).map((q) => ({ de: 'sys', erro: !!q.erro,
        txt: q.erro ? `consulta ${q.no} — ERRO NO BANCO: ${q.erro}` : `consulta ${q.no}: ${q.encontrado ? '✓ encontrado' : '✗ não encontrado'}` }));
      setChat([...sys, ...data.mensagens.map((m) => ({ de: 'bot', txt: m }))]);
      setEstadoSim(data.estado);
      if (data.acao) setSimAtivo(false);
      setErros([]);
    } catch (e) {
      setSimAtivo(false);
      setErros(e.response?.data?.detalhes || [e.response?.data?.error || 'Erro na simulação.']);
    }
  }

  // ---- salvar ----
  async function salvar() {
    setSalvando(true);
    setErros([]);
    try {
      const body = { nome: nome.trim(), numeroId: numeroId ? Number(numeroId) : null, definicao: def };
      if (fluxoId) await api.put(`/fluxos/${fluxoId}`, body);
      else await api.post('/fluxos', body);
      onSaved();
    } catch (e) {
      setErros(e.response?.data?.detalhes || [e.response?.data?.error || 'Falha ao salvar.']);
    } finally {
      setSalvando(false);
    }
  }

  if (carregando) {
    return <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center"><Spinner /></div>;
  }

  return (
    <div className="fixed inset-0 z-50 bg-paper-100 flex flex-col">
      {/* Topo */}
      <div className="bg-ink-950 text-white px-4 py-2.5 flex items-center gap-3 shrink-0">
        <span className="section-bar" />
        <h2 className="font-display font-bold text-[15px] shrink-0">{fluxoId ? 'Editar fluxo' : 'Novo fluxo'}</h2>
        <input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Nome do fluxo (ex.: Menu Principal)"
          className="flex-1 max-w-xs bg-white/10 border border-white/15 rounded-lg px-3 py-1.5 text-sm placeholder-white/35 outline-none focus:border-white/50" />
        <select value={numeroId} onChange={(e) => setNumeroId(e.target.value)}
          className="bg-white/10 border border-white/15 rounded-lg px-2 py-1.5 text-sm outline-none [&>option]:text-stone-800">
          <option value="">Sem número</option>
          {(numeros.data || []).map((n) => (
            <option key={n.id} value={n.id}>{n.nomeExibicao || formatPhone(n.displayPhone) || n.phoneNumberId}</option>
          ))}
        </select>
        <div className="flex-1" />
        <button onClick={salvar} disabled={!nome.trim() || salvando}
          className="px-5 py-1.5 rounded-lg bg-bordeaux-700 hover:bg-bordeaux-800 text-white text-sm font-semibold disabled:opacity-50">
          {salvando ? 'Salvando…' : 'Salvar'}
        </button>
        <button onClick={onClose} className="text-white/60 hover:text-white px-1 text-lg leading-none" aria-label="Fechar">✕</button>
      </div>

      {erros.length > 0 && (
        <div className="shrink-0 bg-red-50 border-b border-red-200 px-4 py-2 max-h-24 overflow-y-auto">
          {erros.map((e, i) => <p key={i} className="text-xs text-red-700">• {e}</p>)}
        </div>
      )}

      <div className="flex-1 min-h-0 flex justify-center gap-0">
        {/* Coluna central: timeline de passos */}
        <div className="flex-1 max-w-3xl overflow-y-auto px-4 py-5">
          {/* Config geral (recolhível) */}
          <div className="bg-white rounded-2xl border border-black/[0.06] mb-5">
            <button onClick={() => setConfigAberta((v) => !v)}
              className="w-full flex items-center gap-2 px-4 py-3 text-left">
              <span className="section-bar" />
              <span className="font-display font-bold text-sm text-stone-800 flex-1">Configuração geral</span>
              <span className="font-mono text-[10px] text-stone-400">
                início: {def.config?.inicio || '—'} · timeout {def.config?.timeoutMin || 30}min
              </span>
              <svg className={`w-4 h-4 text-stone-400 transition-transform ${configAberta ? 'rotate-180' : ''}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {configAberta && (
              <div className="px-4 pb-4 space-y-3 border-t border-black/[0.05] pt-3">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <SelectProximo rotulo="Passo inicial" valor={def.config?.inicio}
                    onChange={(v) => setCfg({ inicio: v })} nos={nos} />
                  <div>
                    <Rotulo>Timeout (min)</Rotulo>
                    <input type="number" min="1" className="input-field !py-2 !text-sm" value={def.config?.timeoutMin || 30}
                      onChange={(e) => setCfg({ timeoutMin: Number(e.target.value) || 30 })} />
                  </div>
                  <div>
                    <Rotulo>Máx. inválidas</Rotulo>
                    <input type="number" min="1" className="input-field !py-2 !text-sm" value={def.config?.maxInvalidas || 3}
                      onChange={(e) => setCfg({ maxInvalidas: Number(e.target.value) || 3 })} />
                  </div>
                  <div>
                    <Rotulo>Após máx. inválidas</Rotulo>
                    <select className="input-field !py-2 !text-sm"
                      value={def.config?.acaoMaxInvalidas?.tipo === 'transferir' ? String(def.config.acaoMaxInvalidas.departamentoId || '') : ''}
                      onChange={(e) => setCfg({
                        acaoMaxInvalidas: e.target.value
                          ? { tipo: 'transferir', departamentoId: Number(e.target.value), texto: 'Vou te passar para um atendente. 👤' }
                          : { tipo: 'encerrar', texto: 'Não consegui entender. Encerrando — chame de novo quando precisar!' },
                      })}>
                      <option value="">Encerrar</option>
                      {(deptos.data || []).map((d) => <option key={d.id} value={d.id}>Transferir → {d.nome}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  <Rotulo>Mensagem de opção inválida</Rotulo>
                  <textarea rows={1} className="input-field !py-2 !text-sm resize-y"
                    value={def.config?.msgOpcaoInvalida || ''} onChange={(e) => setCfg({ msgOpcaoInvalida: e.target.value })} />
                </div>
              </div>
            )}
          </div>

          {/* Timeline */}
          <div className="relative">
            <span aria-hidden className="absolute left-[15px] top-2 bottom-2 w-px bg-stone-300" />
            <div className="space-y-4">
              {nos.map((no, idx) => {
                const t = tipoDe(no.tipo);
                const ehInicio = def.config?.inicio === no.id;
                return (
                  <div key={idx} className="relative pl-10">
                    {/* Nó da timeline */}
                    <span className="absolute left-0 top-3 w-8 h-8 rounded-full flex items-center justify-center
                                     text-[13px] text-white shadow-sm ring-4 ring-paper-100"
                      style={{ backgroundColor: t.cor }} title={t.rotulo}>
                      {t.icone}
                    </span>

                    <div className="bg-white rounded-2xl border border-black/[0.06] overflow-hidden">
                      <div className="flex items-center gap-2 px-4 py-2 border-b border-black/[0.05]"
                        style={{ backgroundColor: `${t.cor}0d` }}>
                        <span className="font-mono text-[10px] uppercase tracking-widest font-medium" style={{ color: t.cor }}>
                          {t.rotulo}
                        </span>
                        <input value={no.id}
                          onChange={(e) => setNo(idx, { id: e.target.value.replace(/\s+/g, '_').toLowerCase() })}
                          className="font-mono text-xs text-stone-500 bg-transparent border-b border-dashed border-stone-300
                                     px-1 py-0.5 w-44 outline-none focus:border-brand-700" />
                        {ehInicio && (
                          <span className="font-mono text-[9px] uppercase px-1.5 py-0.5 rounded bg-brand-700 text-white">início</span>
                        )}
                        <div className="flex-1" />
                        <button onClick={() => moverNo(idx, -1)} disabled={idx === 0}
                          className="text-stone-300 hover:text-brand-700 disabled:opacity-30 disabled:hover:text-stone-300 px-0.5"
                          title="Mover para cima" aria-label="Mover para cima">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                          </svg>
                        </button>
                        <button onClick={() => moverNo(idx, 1)} disabled={idx === nos.length - 1}
                          className="text-stone-300 hover:text-brand-700 disabled:opacity-30 disabled:hover:text-stone-300 px-0.5"
                          title="Mover para baixo" aria-label="Mover para baixo">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </button>
                        <button onClick={() => removerNo(idx)}
                          className="text-stone-300 hover:text-bordeaux-700 transition-colors" aria-label="Remover passo">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>

                      <div className="p-4 space-y-3">
                        {no.tipo !== 'consulta' && no.tipo !== 'boleto' && (
                        <div>
                          <Rotulo>Texto enviado ao cliente</Rotulo>
                          <textarea rows={no.tipo === 'menu' ? 4 : 2} value={no.texto || ''}
                            onChange={(e) => setNo(idx, { texto: e.target.value })}
                            className="input-field !py-2 !text-sm resize-y" />
                          <p className="font-mono text-[9px] text-stone-400 mt-0.5">
                            {'{{nome}}'} · {'{{protocolo}}'} · variáveis capturadas, ex.: {'{{codigo_rca}}'}
                          </p>
                        </div>
                        )}

                        {no.tipo === 'consulta' && (
                          <>
                            <div>
                              <Rotulo>SELECT no Oracle (use :variavel como parâmetro)</Rotulo>
                              <textarea rows={3} value={no.sql || ''}
                                onChange={(e) => setNo(idx, { sql: e.target.value })}
                                spellCheck={false}
                                className="input-field !py-2 !text-[12px] font-mono resize-y"
                                placeholder="SELECT NOME FROM MCCANAL.PCUSUARI WHERE CODUSUR = :codigo_rca" />
                              <p className="font-mono text-[9px] text-stone-400 mt-0.5">
                                :codigo_rca usa a variável capturada · as colunas do resultado viram
                                variáveis (ex.: NOME → {'{{nome}}'}) · só SELECT, sem ";"
                              </p>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                              <SelectProximo rotulo="Se ENCONTROU → vai para" valor={no.seEncontrado}
                                onChange={(v) => setNo(idx, { seEncontrado: v })} nos={nos} excluirId={no.id} />
                              <SelectProximo rotulo="Se NÃO encontrou → vai para" valor={no.seNaoEncontrado}
                                onChange={(v) => setNo(idx, { seNaoEncontrado: v })} nos={nos} excluirId={no.id} />
                            </div>
                          </>
                        )}


                        {no.tipo === 'mensagem' && (
                          <SelectProximo valor={no.proximo} onChange={(v) => setNo(idx, { proximo: v })} nos={nos} excluirId={no.id} />
                        )}

                        {no.tipo === 'menu' && (
                          <div className="space-y-1.5">
                            <Rotulo>Opções — o cliente digita o valor</Rotulo>
                            {(no.opcoes || []).map((op, oi) => (
                              <div key={oi} className="flex items-center gap-2">
                                <div className="flex flex-col -my-1">
                                  <button onClick={() => moverOpcao(idx, oi, -1)} disabled={oi === 0}
                                    className="text-stone-300 hover:text-brand-700 disabled:opacity-25 leading-none text-[10px]"
                                    aria-label="Subir opção">▲</button>
                                  <button onClick={() => moverOpcao(idx, oi, 1)} disabled={oi === (no.opcoes || []).length - 1}
                                    className="text-stone-300 hover:text-brand-700 disabled:opacity-25 leading-none text-[10px]"
                                    aria-label="Descer opção">▼</button>
                                </div>
                                <input value={op.valor} onChange={(e) => {
                                  const ops = [...no.opcoes]; ops[oi] = { ...op, valor: e.target.value }; setNo(idx, { opcoes: ops });
                                }} className="w-12 input-field !py-1.5 !text-sm text-center font-mono" placeholder="1" />
                                <svg className="w-3.5 h-3.5 text-stone-300 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                                </svg>
                                <select className="input-field !py-1.5 !text-sm flex-1" value={op.proximo || ''}
                                  onChange={(e) => { const ops = [...no.opcoes]; ops[oi] = { ...op, proximo: e.target.value }; setNo(idx, { opcoes: ops }); }}>
                                  <option value="">— vai para… —</option>
                                  {nos.filter((n) => n.id !== no.id).map((n) => (
                                    <option key={n.id} value={n.id}>{tipoDe(n.tipo).icone} {n.id}</option>
                                  ))}
                                </select>
                                <button onClick={() => setNo(idx, { opcoes: no.opcoes.filter((_, i) => i !== oi) })}
                                  className="text-stone-300 hover:text-bordeaux-700" aria-label="Remover opção">✕</button>
                              </div>
                            ))}
                            <button onClick={() => setNo(idx, { opcoes: [...(no.opcoes || []), { valor: String((no.opcoes || []).length + 1), proximo: '' }] })}
                              className="font-mono text-[11px] text-brand-700 hover:underline">+ adicionar opção</button>
                          </div>
                        )}

                        {no.tipo === 'pergunta' && (
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                            <div>
                              <Rotulo>Variável</Rotulo>
                              <input className="input-field !py-2 !text-sm font-mono" value={no.variavel || ''}
                                onChange={(e) => setNo(idx, { variavel: e.target.value.replace(/\W+/g, '_').toLowerCase() })}
                                placeholder="codigo_rca" />
                            </div>
                            <div>
                              <Rotulo>Validação</Rotulo>
                              <select className="input-field !py-2 !text-sm" value={no.validacao || 'texto'}
                                onChange={(e) => setNo(idx, { validacao: e.target.value })}>
                                <option value="texto">Texto livre</option>
                                <option value="numero">Apenas números</option>
                                <option value="cpf_cnpj">CPF/CNPJ</option>
                              </select>
                            </div>
                            <SelectProximo valor={no.proximo} onChange={(v) => setNo(idx, { proximo: v })} nos={nos} excluirId={no.id} />
                          </div>
                        )}

                        {no.tipo === 'irfluxo' && (
                          <div>
                            <Rotulo>Fluxo de destino (continua lá do início dele)</Rotulo>
                            <select className="input-field !py-2 !text-sm" value={no.fluxo || ''}
                              onChange={(e) => setNo(idx, { fluxo: e.target.value, fluxoId: undefined })}>
                              <option value="">— selecione o fluxo —</option>
                              {(fluxosLista.data || []).filter((f) => f.nome !== nome).map((f) => (
                                <option key={f.id} value={f.nome}>{f.nome}</option>
                              ))}
                              {/* mantém visível um destino que ainda não está na lista (ex.: importado) */}
                              {no.fluxo && !(fluxosLista.data || []).some((f) => f.nome === no.fluxo) && (
                                <option value={no.fluxo}>{no.fluxo}</option>
                              )}
                            </select>
                            <p className="font-mono text-[9px] text-stone-400 mt-0.5">
                              referencia pelo NOME do fluxo · as variáveis capturadas ({'{{codigo_rca}}'} etc.) seguem disponíveis lá
                            </p>
                          </div>
                        )}

                        {no.tipo === 'transferir' && (
                          <div>
                            <Rotulo>Departamento de destino</Rotulo>
                            <select className="input-field !py-2 !text-sm" value={no.departamentoId || ''}
                              onChange={(e) => setNo(idx, { departamentoId: Number(e.target.value) || '' })}>
                              <option value="">— selecione —</option>
                              {(deptos.data || []).map((d) => <option key={d.id} value={d.id}>{d.nome}</option>)}
                            </select>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Adicionar passo */}
            <div className="relative pl-10 mt-4">
              <span className="absolute left-[7px] top-2 w-[17px] h-[17px] rounded-full border-2 border-dashed border-stone-300 bg-paper-100" />
              <div className="flex flex-wrap gap-1.5">
                {TIPOS.map((t) => (
                  <button key={t.id} onClick={() => addNo(t.id)} title={t.desc}
                    className="px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors bg-white hover:text-white"
                    style={{ borderColor: `${t.cor}55`, color: t.cor }}
                    onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = t.cor; e.currentTarget.style.color = '#fff'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = ''; e.currentTarget.style.color = t.cor; }}>
                    {t.icone} {t.rotulo}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Coluna direita: preview em moldura de celular */}
        <aside className="hidden md:flex w-[400px] shrink-0 items-center justify-center p-5 bg-paper-200/60 border-l border-black/[0.05]">
          <div className="w-full max-w-[340px] h-[640px] max-h-full rounded-[2rem] bg-ink-950 p-[10px] shadow-2xl flex flex-col">
            {/* #e5ddd3 e #d9fdd3 abaixo replicam de propósito o wallpaper e a
                bolha do WhatsApp real (não são cor da Olume) — é o preview
                "como o cliente vai ver", tem que parecer o app dele. */}
            <div className="rounded-[1.5rem] overflow-hidden flex-1 flex flex-col bg-[#e5ddd3]">
              {/* Header do chat */}
              <div className="shrink-0 bg-ink-900 text-white px-3 py-2.5 flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-full navy-gradient flex items-center justify-center font-display font-bold text-xs">{empresa.trim().slice(0, 1).toUpperCase()}</div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-semibold leading-tight truncate">{empresa}</p>
                  <p className="text-[10px] text-emerald-300 leading-tight">{simAtivo ? 'bot respondendo…' : 'online'}</p>
                </div>
                <button onClick={iniciarSim}
                  className="font-mono text-[10px] px-2.5 py-1 rounded-md bg-bordeaux-700 hover:bg-bordeaux-800 font-medium">
                  {chat.length ? '↻ reiniciar' : '▶ testar'}
                </button>
              </div>

              {/* Mensagens */}
              <div ref={chatRef} className="flex-1 overflow-y-auto px-2.5 py-3 space-y-1.5"
                style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(0,0,0,0.04) 1px, transparent 0)', backgroundSize: '14px 14px' }}>
                {chat.length === 0 && (
                  <div className="text-center mt-16 px-6">
                    <p className="text-3xl mb-2">🤖</p>
                    <p className="text-xs text-stone-500">
                      Aperte <span className="font-semibold">▶ testar</span> e converse com o bot exatamente como o cliente vai ver.
                    </p>
                  </div>
                )}
                {chat.map((m, i) => m.de === 'sys' ? (
                  m.erro ? (
                    <p key={i} className="font-mono text-[10px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1 my-1">{m.txt}</p>
                  ) : (
                    <p key={i} className="font-mono text-[10px] text-stone-500 text-center py-1.5">— {m.txt} —</p>
                  )
                ) : (
                  <div key={i} className={`flex ${m.de === 'cliente' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[82%] rounded-lg px-2.5 py-1.5 text-[13px] whitespace-pre-wrap shadow-sm
                      ${m.de === 'cliente'
                        ? 'bg-[#d9fdd3] text-stone-800 rounded-tr-none'
                        : 'bg-white text-stone-800 rounded-tl-none'}`}>
                      {m.txt}
                    </div>
                  </div>
                ))}
              </div>

              {/* Input */}
              <form onSubmit={(e) => { e.preventDefault(); if (entrada.trim() && simAtivo) { simular(entrada.trim()); setEntrada(''); } }}
                className="shrink-0 p-2 bg-paper-200 flex gap-1.5">
                <input value={entrada} onChange={(e) => setEntrada(e.target.value)}
                  disabled={!simAtivo}
                  placeholder={simAtivo ? 'Responda como o cliente…' : 'Inicie o teste acima'}
                  className="flex-1 bg-white rounded-full px-3.5 py-2 text-[13px] outline-none disabled:opacity-50 border border-black/[0.06]" />
                <button type="submit" disabled={!simAtivo || !entrada.trim()}
                  className="w-9 h-9 rounded-full bg-brand-700 text-white flex items-center justify-center disabled:opacity-40">
                  <svg className="w-4 h-4 -rotate-45 translate-x-px" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                  </svg>
                </button>
              </form>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
