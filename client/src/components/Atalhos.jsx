import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../services/api';
import Spinner from './ui/Spinner';
import { useAuth } from '../context/AuthContext';

export function useAtalhos() {
  return useQuery({
    queryKey: ['atalhos'],
    queryFn: () => api.get('/atalhos').then((r) => r.data),
    staleTime: 60_000,
  });
}

// Dropdown que aparece sobre o composer quando o texto começa com "/".
export function AtalhosDropdown({ filtro, onEscolher, onGerenciar }) {
  const atalhos = useAtalhos();
  const termo = filtro.toLowerCase();
  const lista = (atalhos.data || []).filter((a) =>
    !termo || a.atalho.includes(termo) || (a.titulo || '').toLowerCase().includes(termo)
  );

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 bg-white rounded-xl shadow-xl border border-black/10 overflow-hidden z-30">
      <div className="flex items-center justify-between px-3 py-2 border-b border-black/[0.05]">
        <p className="font-mono text-[10px] uppercase tracking-widest text-stone-400">
          atalhos {lista.length ? `(${lista.length})` : ''}
        </p>
        <button type="button" onClick={onGerenciar}
          className="text-[11px] text-brand-700 font-medium hover:underline">⚙ gerenciar</button>
      </div>
      <div className="max-h-56 overflow-y-auto">
        {atalhos.isLoading && <div className="p-4 flex justify-center"><Spinner /></div>}
        {lista.map((a) => (
          <button key={a.id} type="button" onClick={() => onEscolher(a)}
            className="w-full text-left px-3 py-2 hover:bg-paper-50 border-b border-black/[0.03] last:border-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-brand-700">/{a.atalho}</span>
              {a.escopo === 'departamento' ? (
                <span className="font-mono text-[9px] uppercase px-1.5 py-0.5 rounded bg-brand-50 text-brand-700">
                  {a.departamentoNome || 'depto'}
                </span>
              ) : (
                <span className="font-mono text-[9px] uppercase px-1.5 py-0.5 rounded bg-stone-100 text-stone-400">pessoal</span>
              )}
            </div>
            <p className="text-xs text-stone-500 truncate mt-0.5">{a.titulo || a.conteudo}</p>
          </button>
        ))}
        {!atalhos.isLoading && lista.length === 0 && (
          <p className="px-3 py-4 text-xs text-stone-400 text-center">
            Nenhum atalho{termo ? ` para "/${termo}"` : ''} — crie em ⚙ gerenciar.
          </p>
        )}
      </div>
    </div>
  );
}

// Modal de gerenciamento: lista + criar + excluir (só os meus).
export function AtalhosModal({ onClose }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const atalhos = useAtalhos();
  const deptos = useQuery({
    queryKey: ['departamentos'],
    queryFn: () => api.get('/departamentos').then((r) => r.data),
  });

  const [atalho, setAtalho] = useState('');
  const [conteudo, setConteudo] = useState('');
  const [escopo, setEscopo] = useState('pessoal');
  const [departamentoId, setDepartamentoId] = useState('');
  const [erro, setErro] = useState('');

  const meusDeptos = (deptos.data || []).filter((d) => (user?.deptoIds || []).includes(d.id));
  const opcoesDepto = user?.papel === 'ADMIN' ? (deptos.data || []) : meusDeptos;

  const criar = useMutation({
    mutationFn: () => api.post('/atalhos', {
      atalho, conteudo, escopo,
      departamentoId: escopo === 'departamento' ? Number(departamentoId) : undefined,
    }),
    onSuccess: () => {
      setAtalho(''); setConteudo(''); setErro('');
      qc.invalidateQueries({ queryKey: ['atalhos'] });
    },
    onError: (e) => setErro(e.response?.data?.error || 'Falha ao criar.'),
  });

  const excluir = useMutation({
    mutationFn: (id) => api.delete(`/atalhos/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['atalhos'] }),
    onError: (e) => setErro(e.response?.data?.error || 'Falha ao excluir.'),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full sm:max-w-lg bg-white rounded-t-2xl sm:rounded-2xl overflow-hidden max-h-[92vh] flex flex-col">
        <div className="navy-gradient text-white px-4 py-3 flex items-center gap-2 shrink-0">
          <span className="section-bar" />
          <h2 className="font-display font-bold text-base flex-1">Meus atalhos</h2>
          <button onClick={onClose} className="text-white/70 hover:text-white" aria-label="Fechar">✕</button>
        </div>

        <div className="p-4 overflow-y-auto space-y-4">
          {/* Criar */}
          <div className="bg-paper-50 rounded-xl border border-black/[0.06] p-3 space-y-2.5">
            <div className="flex gap-2">
              <div className="w-44">
                <label className="block font-mono text-[10px] uppercase tracking-widest text-stone-400 mb-1">Atalho</label>
                <div className="flex items-center">
                  <span className="font-mono text-sm text-stone-400 mr-0.5">/</span>
                  <input className="input-field !py-2 !text-sm font-mono" value={atalho}
                    onChange={(e) => setAtalho(e.target.value.toLowerCase().replace(/\s+/g, '-'))}
                    placeholder="sem-credito" />
                </div>
              </div>
              <div className="flex-1">
                <label className="block font-mono text-[10px] uppercase tracking-widest text-stone-400 mb-1">Quem vê</label>
                <div className="flex gap-1.5">
                  <select className="input-field !py-2 !text-sm" value={escopo} onChange={(e) => setEscopo(e.target.value)}>
                    <option value="pessoal">Só eu</option>
                    <option value="departamento">Departamento</option>
                  </select>
                  {escopo === 'departamento' && (
                    <select className="input-field !py-2 !text-sm" value={departamentoId}
                      onChange={(e) => setDepartamentoId(e.target.value)}>
                      <option value="">qual?</option>
                      {opcoesDepto.map((d) => <option key={d.id} value={d.id}>{d.nome}</option>)}
                    </select>
                  )}
                </div>
              </div>
            </div>
            <div>
              <label className="block font-mono text-[10px] uppercase tracking-widest text-stone-400 mb-1">Texto da resposta</label>
              <textarea rows={2} className="input-field !py-2 !text-sm resize-y" value={conteudo}
                onChange={(e) => setConteudo(e.target.value)}
                placeholder="Ex.: Limites acima de R$ 4.000,00 somente via e-mail." />
            </div>
            {erro && <p className="text-xs text-red-600">{erro}</p>}
            <button onClick={() => criar.mutate()}
              disabled={!atalho.trim() || !conteudo.trim() || (escopo === 'departamento' && !departamentoId) || criar.isPending}
              className="px-4 py-2 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-sm font-semibold disabled:opacity-40">
              {criar.isPending ? 'Criando…' : '+ Criar atalho'}
            </button>
          </div>

          {/* Lista */}
          <div className="divide-y divide-black/[0.04]">
            {(atalhos.data || []).map((a) => (
              <div key={a.id} className="flex items-start gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-brand-700">/{a.atalho}</span>
                    <span className={`font-mono text-[9px] uppercase px-1.5 py-0.5 rounded
                      ${a.escopo === 'departamento' ? 'bg-brand-50 text-brand-700' : 'bg-stone-100 text-stone-400'}`}>
                      {a.escopo === 'departamento' ? (a.departamentoNome || 'depto') : 'pessoal'}
                    </span>
                  </div>
                  <p className="text-xs text-stone-500 mt-0.5 whitespace-pre-wrap">{a.conteudo}</p>
                </div>
                {(a.meu || user?.papel === 'ADMIN') && (
                  <button onClick={() => excluir.mutate(a.id)}
                    className="shrink-0 text-stone-300 hover:text-red-600 text-sm" aria-label="Excluir">🗑</button>
                )}
              </div>
            ))}
            {atalhos.data?.length === 0 && (
              <p className="py-4 text-xs text-stone-400 text-center">Nenhum atalho ainda — crie o primeiro acima.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
