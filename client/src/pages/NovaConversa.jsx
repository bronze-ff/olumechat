import { useState, useMemo } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import api from '../services/api';
import { formatPhone } from '../utils/formatters';
import { useAuth } from '../context/AuthContext';

// Substitui {{1}},{{2}}... pelo valor digitado (preview do que será enviado).
function montarPreview(body, vars) {
  return (body || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => vars[n - 1] || `{{${n}}}`);
}

export default function NovaConversa({ onClose, onCreated, contatoInicial }) {
  // Modo "Reabrir": o contato já está definido (janela de 24h expirou) — o
  // atendente só escolhe o template; telefone, cliente, canal e fila ficam fixos.
  const fixo = !!contatoInicial;
  const [aba, setAba] = useState('cliente'); // 'cliente' | 'manual'
  const [busca, setBusca] = useState('');
  const [telefone, setTelefone] = useState(contatoInicial?.telefone || '');
  const [codigoExterno, setCodigoExterno] = useState(contatoInicial?.codigoExterno || null);
  const [clienteNome, setClienteNome] = useState(contatoInicial?.nome || '');
  const [templateName, setTemplateName] = useState('');
  // No modo Reabrir o número NÃO é fixado no canal da conversa: conversas que
  // expiram costumam vir do receptivo (PERMITE_ATIVO='N'), que não pode originar
  // disparo. Então o canal de envio é escolhido entre os habilitados (auto-seleção
  // quando só há um — ex.: 1061). O contato é que fica fixo.
  const [numeroId, setNumeroId] = useState('');
  const [departamentoId, setDepartamentoId] = useState('');
  const [vars, setVars] = useState([]);
  const [erro, setErro] = useState('');
  const { user } = useAuth();

  const templates = useQuery({
    queryKey: ['templates'],
    queryFn: () => api.get('/templates').then((r) => r.data),
  });

  // Números habilitados a originar conversa ativa (PERMITE_ATIVO='S').
  const numeros = useQuery({
    queryKey: ['numeros-ativos'],
    queryFn: () => api.get('/numeros/ativos').then((r) => r.data),
  });
  // Um único número habilitado → já seleciona sozinho.
  const numUnico = numeros.data?.length === 1 ? numeros.data[0] : null;
  const numeroEscolhido = numeroId || (numUnico ? String(numUnico.id) : '');

  // Departamentos: só precisam ser escolhidos quando o número de origem NÃO tem
  // um departamento padrão (senão a conversa segue o padrão do número no servidor).
  const departamentos = useQuery({
    queryKey: ['departamentos'],
    queryFn: () => api.get('/departamentos').then((r) => r.data),
    staleTime: 5 * 60_000,
  });
  const numAtual = (numeros.data || []).find((n) => String(n.id) === String(numeroEscolhido)) || null;
  const precisaDepto = !fixo && !!numAtual && !numAtual.departamentoPadraoId;
  const verTudo = user?.papel === 'ADMIN' || user?.papel === 'AUDITOR';
  const deptoOpcoes = (departamentos.data || []).filter((d) => verTudo || (user?.deptoIds || []).includes(d.id));

  const clientes = useQuery({
    queryKey: ['clientes', busca],
    queryFn: () => api.get('/clientes', { params: { q: busca } }).then((r) => r.data),
    enabled: aba === 'cliente' && busca.trim().length >= 2,
  });

  const tpl = useMemo(
    () => (templates.data || []).find((t) => t.name === templateName),
    [templates.data, templateName]
  );

  const enviar = useMutation({
    mutationFn: () =>
      api.post('/conversas', {
        telefone,
        codigoExterno,
        templateName,
        numeroId: numeroEscolhido ? Number(numeroEscolhido) : undefined,
        departamentoId: precisaDepto && departamentoId ? Number(departamentoId) : undefined,
        lang: tpl?.language || 'pt_BR',
        variaveis: vars.slice(0, tpl?.varCount || 0),
        preview: montarPreview(tpl?.body, vars),
      }),
    onSuccess: (r) => onCreated(r.data.id),
    onError: (err) => setErro(err.response?.data?.error || 'Falha ao iniciar a conversa.'),
  });

  function escolherTemplate(name) {
    setTemplateName(name);
    const t = (templates.data || []).find((x) => x.name === name);
    setVars(Array(t?.varCount || 0).fill(''));
  }
  function selecionarCliente(c) {
    setTelefone(c.telefone || '');
    // `/clientes` ainda não foi portado (fora do escopo do FIL-60) — aceita o
    // formato novo (codigoExterno) e o antigo (cod/codcli) como fallback.
    setCodigoExterno(c.codigoExterno ?? c.cod ?? c.codcli ?? null);
    setClienteNome(c.cliente || '');
  }

  const podeEnviar = telefone.trim() && templateName && !enviar.isPending
    && vars.slice(0, tpl?.varCount || 0).every((v) => v.trim())
    && ((numeros.data?.length || 0) <= 1 || numeroEscolhido) // 2+ números → escolha obrigatória
    && (!precisaDepto || departamentoId); // número sem padrão → departamento obrigatório

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl overflow-hidden max-h-[92vh] flex flex-col">
        <div className="navy-gradient text-white px-4 py-3 flex items-center gap-2">
          <span className="section-bar" />
          <h2 className="font-display font-bold text-base flex-1">{fixo ? 'Reabrir conversa' : 'Nova conversa'}</h2>
          <button onClick={onClose} className="text-white/70 hover:text-white" aria-label="Fechar">✕</button>
        </div>

        <div className="p-4 overflow-y-auto space-y-4">
          {fixo ? (
            <div className="bg-paper-50 border border-black/[0.07] rounded-lg p-3">
              <p className="text-sm font-semibold text-stone-800 truncate">{clienteNome || formatPhone(telefone)}</p>
              <p className="text-xs text-stone-500 font-mono">{formatPhone(telefone)} · reabrindo este atendimento</p>
            </div>
          ) : (<>
          {/* Origem do contato */}
          <div className="flex gap-1 bg-stone-100 rounded-lg p-1">
            {['cliente', 'manual'].map((a) => (
              <button key={a} onClick={() => setAba(a)}
                className={`flex-1 py-1.5 text-sm rounded-md font-medium transition-colors
                  ${aba === a ? 'bg-white text-brand-700 shadow-sm' : 'text-stone-500'}`}>
                {a === 'cliente' ? 'Buscar cliente' : 'Telefone manual'}
              </button>
            ))}
          </div>

          {aba === 'cliente' ? (
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Cliente (nome ou código)</label>
              <input className="input-field" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Ex.: Padaria do João ou 12345" />
              {clientes.isFetching && <p className="text-xs text-stone-400 mt-1">Buscando…</p>}
              {clientes.isError && <p className="text-xs text-red-600 mt-1">{clientes.error.response?.data?.error || 'Erro na busca.'}</p>}
              <div className="mt-2 max-h-40 overflow-y-auto divide-y divide-black/[0.05]">
                {(clientes.data || []).map((c) => (
                  <button key={c.codigoExterno ?? c.cod ?? c.codcli} onClick={() => selecionarCliente(c)}
                    className={`w-full text-left px-2 py-2 text-sm rounded hover:bg-paper-50
                      ${codigoExterno === (c.codigoExterno ?? c.cod ?? c.codcli) ? 'bg-brand-50' : ''}`}>
                    <div className="font-medium text-stone-800 truncate">{c.cliente}</div>
                    <div className="text-xs text-stone-500 font-mono">#{c.codigoExterno ?? c.cod ?? c.codcli} · {formatPhone(c.telefone)}</div>
                  </button>
                ))}
              </div>
              {telefone && (
                <p className="text-xs text-stone-600 mt-2">
                  Selecionado: <span className="font-semibold">{clienteNome}</span> — {formatPhone(telefone)}
                </p>
              )}
            </div>
          ) : (
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Telefone (com DDD)</label>
              <input className="input-field font-mono" value={telefone} onChange={(e) => { setTelefone(e.target.value); setCodigoExterno(null); }}
                placeholder="62 99999-9999" inputMode="numeric" />
            </div>
          )}
          </>)}

          {/* Número de origem (só pede escolha quando há mais de um habilitado) */}
          {(numeros.data?.length || 0) > 1 && (
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Enviar pelo número</label>
              <select className="input-field" value={numeroEscolhido} onChange={(e) => setNumeroId(e.target.value)}>
                <option value="">Selecione…</option>
                {numeros.data.map((n) => (
                  <option key={n.id} value={n.id}>{n.nomeExibicao || formatPhone(n.displayPhone) || `Número #${n.id}`}</option>
                ))}
              </select>
              <p className="text-[11px] text-stone-400 mt-1">Só aparecem números habilitados para conversa ativa (Admin → Números).</p>
            </div>
          )}
          {numUnico && (
            <p className="text-[11px] text-stone-400">
              Enviando pelo número <span className="font-semibold text-stone-600">{numUnico.nomeExibicao || formatPhone(numUnico.displayPhone)}</span>.
            </p>
          )}

          {/* Departamento da conversa: número COM padrão → indica a fila; número
              SEM padrão → pede a escolha (senão a conversa cairia no "Geral"). */}
          {!fixo && numAtual && numAtual.departamentoPadraoId ? (
            <p className="text-[11px] text-stone-400">
              Entra na fila de <span className="font-semibold text-stone-600">{numAtual.departamentoPadraoNome || `Departamento #${numAtual.departamentoPadraoId}`}</span>.
            </p>
          ) : precisaDepto ? (
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Departamento da conversa</label>
              <select className="input-field" value={departamentoId} onChange={(e) => setDepartamentoId(e.target.value)}>
                <option value="">Selecione…</option>
                {deptoOpcoes.map((d) => (
                  <option key={d.id} value={d.id}>{d.nome}</option>
                ))}
              </select>
              <p className="text-[11px] text-stone-400 mt-1">Este número não tem departamento padrão — escolha pra qual fila esta conversa vai (senão cairia no “Geral”).</p>
            </div>
          ) : null}

          {/* Template */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Template aprovado</label>
            {templates.isLoading ? (
              <p className="text-xs text-stone-400">Carregando templates…</p>
            ) : templates.isError ? (
              <p className="text-xs text-red-600">{templates.error.response?.data?.error || 'Erro ao listar templates.'}</p>
            ) : (templates.data || []).length === 0 ? (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                Nenhum template aprovado ainda. Submeta e aprove um template `utility` na Meta.
              </p>
            ) : (
              <select className="input-field" value={templateName} onChange={(e) => escolherTemplate(e.target.value)}>
                <option value="">Selecione…</option>
                {templates.data.map((t) => (
                  <option key={t.name} value={t.name}>{t.name} ({t.language})</option>
                ))}
              </select>
            )}
          </div>

          {/* Variáveis */}
          {tpl && tpl.varCount > 0 && (
            <div className="space-y-2">
              {Array.from({ length: tpl.varCount }).map((_, i) => (
                <div key={i}>
                  <label className="block text-[11px] font-mono uppercase tracking-wide text-stone-500 mb-1">Variável {`{{${i + 1}}}`}</label>
                  <input className="input-field !py-2"
                    value={vars[i] || ''}
                    onChange={(e) => setVars((p) => { const n = [...p]; n[i] = e.target.value; return n; })} />
                </div>
              ))}
            </div>
          )}

          {/* Preview */}
          {tpl && (
            <div>
              <label className="block text-[11px] font-mono uppercase tracking-wide text-stone-500 mb-1">Pré-visualização</label>
              <div className="text-sm bg-paper-50 border border-black/[0.07] rounded-lg p-3 whitespace-pre-wrap">
                {montarPreview(tpl.body, vars)}
              </div>
            </div>
          )}

          {erro && <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{erro}</div>}
        </div>

        <div className="p-3 border-t border-black/[0.06] flex gap-2 safe-bottom">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-black/20 text-stone-700 font-semibold text-sm">Cancelar</button>
          <button onClick={() => { setErro(''); enviar.mutate(); }} disabled={!podeEnviar}
            className="flex-1 py-2.5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white font-semibold text-sm disabled:opacity-40 disabled:cursor-not-allowed">
            {enviar.isPending ? 'Enviando…' : (fixo ? 'Reabrir conversa' : 'Iniciar conversa')}
          </button>
        </div>
      </div>
    </div>
  );
}
