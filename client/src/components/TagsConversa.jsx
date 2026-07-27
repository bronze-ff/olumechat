import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../services/api';

const CORES = ['#1B5E7B', '#9B1B1B', '#2F7D4F', '#B7791F', '#5B4B8A', '#0E7490'];

// Controle de tags da conversa: mostra as tags atuais (chips) e um seletor
// para marcar/desmarcar e criar novas. Persiste via PUT /conversas/:id/tags.
export default function TagsConversa({ conversaId, tags = [] }) {
  const [aberto, setAberto] = useState(false);
  const [novo, setNovo] = useState('');
  const box = useRef(null);
  const qc = useQueryClient();

  const catalogo = useQuery({
    queryKey: ['tags'],
    queryFn: () => api.get('/tags').then((r) => r.data),
  });

  const salvar = useMutation({
    mutationFn: (ids) => api.put(`/conversas/${conversaId}/tags`, { tags: ids }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['conversas'] }),
  });

  const criar = useMutation({
    mutationFn: (nome) => api.post('/tags', { nome, cor: CORES[(catalogo.data?.length || 0) % CORES.length] }),
    onSuccess: (r) => {
      setNovo('');
      qc.invalidateQueries({ queryKey: ['tags'] });
      salvar.mutate([...tags, r.data.id]);
    },
  });

  useEffect(() => {
    function fora(e) { if (box.current && !box.current.contains(e.target)) setAberto(false); }
    document.addEventListener('mousedown', fora);
    return () => document.removeEventListener('mousedown', fora);
  }, []);

  const porId = (id) => (catalogo.data || []).find((t) => t.id === id);
  const toggle = (id) => {
    const novos = tags.includes(id) ? tags.filter((t) => t !== id) : [...tags, id];
    salvar.mutate(novos);
  };

  return (
    <div className="relative flex items-center gap-1" ref={box}>
      {tags.map((id) => {
        const t = porId(id);
        if (!t) return null;
        return (
          <span key={id} className="text-[10px] font-medium px-1.5 py-0.5 rounded-full text-white"
            style={{ backgroundColor: t.cor || '#1B5E7B' }}>
            {t.nome}
          </span>
        );
      })}
      <button onClick={() => setAberto((v) => !v)}
        className="text-[10px] px-1.5 py-0.5 rounded-full border border-black/15 text-stone-500 hover:bg-stone-100"
        title="Etiquetas">
        + tag
      </button>

      {aberto && (
        <div className="absolute top-7 right-0 z-20 w-52 bg-white rounded-xl shadow-lg border border-black/10 p-2">
          <div className="max-h-48 overflow-y-auto space-y-0.5">
            {catalogo.isLoading && <p className="text-xs text-stone-400 px-1 py-1">Carregando…</p>}
            {(catalogo.data || []).map((t) => (
              <button key={t.id} onClick={() => toggle(t.id)}
                className="w-full flex items-center gap-2 px-1.5 py-1 rounded hover:bg-paper-50 text-left">
                <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: t.cor || '#1B5E7B' }} />
                <span className="text-sm text-stone-700 flex-1 truncate">{t.nome}</span>
                {tags.includes(t.id) && <span className="text-brand-700 text-xs">✓</span>}
              </button>
            ))}
            {catalogo.data?.length === 0 && <p className="text-xs text-stone-400 px-1 py-1">Nenhuma tag ainda.</p>}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); const n = novo.trim(); if (n) criar.mutate(n); }}
            className="flex gap-1 mt-2 pt-2 border-t border-black/5">
            <input value={novo} onChange={(e) => setNovo(e.target.value)} placeholder="Nova tag…"
              className="flex-1 text-sm px-2 py-1 rounded border border-black/15 outline-none focus:border-brand-700" />
            <button type="submit" disabled={!novo.trim() || criar.isPending}
              className="px-2 py-1 rounded bg-brand-700 text-white text-xs disabled:opacity-40">+</button>
          </form>
        </div>
      )}
    </div>
  );
}
