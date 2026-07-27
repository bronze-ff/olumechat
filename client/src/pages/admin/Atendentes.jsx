import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../services/api';
import Spinner from '../../components/ui/Spinner';
import Portal from '../../components/ui/Portal';
import { useAuth } from '../../context/AuthContext';
import { formatPhone } from '../../utils/formatters';

const PAPEIS = ['ADMIN', 'SUPERVISOR', 'ATENDENTE', 'AUDITOR'];

function EditarAtendente({ atd, deptos, numeros, onClose }) {
  const { user, refreshPerfil } = useAuth();
  const [papel, setPapel] = useState(atd.papel || 'ATENDENTE');
  const [ativo, setAtivo] = useState(atd.ativo !== 'N');
  const [podeAtivo, setPodeAtivo] = useState(atd.podeAtivo === 'S');
  const [sel, setSel] = useState(new Set(atd.deptoIds || []));
  const [selNum, setSelNum] = useState(new Set(atd.numeroIds || []));
  const [erro, setErro] = useState('');
  const qc = useQueryClient();

  const salvar = useMutation({
    mutationFn: () => api.put(`/atendentes/${atd.id}`, {
      papel, ativo: ativo ? 'S' : 'N', podeAtivo: podeAtivo ? 'S' : 'N',
      deptoIds: [...sel], numeroIds: [...selNum],
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['atendentes'] });
      if (user?.matricula === atd.matricula) refreshPerfil(); // me editei → atualiza meu menu/permissões na hora
      onClose();
    },
    onError: (e) => setErro(e.response?.data?.error || 'Falha ao salvar.'),
  });

  const toggleDepto = (id) => setSel((p) => {
    const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n;
  });
  const toggleNum = (id) => setSelNum((p) => {
    const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n;
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl overflow-hidden max-h-[92vh] flex flex-col">
        <div className="navy-gradient text-white px-4 py-3 flex items-center gap-2">
          <span className="section-bar" />
          <h2 className="font-display font-bold text-base flex-1 truncate">{atd.nome || `Matrícula ${atd.matricula}`}</h2>
          <button onClick={onClose} className="text-white/70 hover:text-white" aria-label="Fechar">✕</button>
        </div>
        <div className="p-4 overflow-y-auto space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Papel</label>
            <select className="input-field" value={papel} onChange={(e) => setPapel(e.target.value)}>
              {PAPEIS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">
              Departamentos (filas que atende)
            </label>
            <div className="space-y-1">
              {(deptos || []).filter((d) => d.ativo === 'S').map((d) => (
                <label key={d.id} className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-paper-50 cursor-pointer">
                  <input type="checkbox" checked={sel.has(d.id)} onChange={() => toggleDepto(d.id)}
                    className="w-4 h-4 accent-brand-700" />
                  <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: d.cor || '#1B5E7B' }} />
                  <span className="text-sm text-stone-700">{d.nome}</span>
                </label>
              ))}
            </div>
            <p className="text-[11px] text-stone-400 mt-1">Marque mais de um se o atendente responde várias filas.</p>
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">
              Números que acessa (canais)
            </label>
            <div className="space-y-1">
              {(numeros || []).filter((n) => n.ativo !== 'N').map((n) => (
                <label key={n.id} className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-paper-50 cursor-pointer">
                  <input type="checkbox" checked={selNum.has(n.id)} onChange={() => toggleNum(n.id)}
                    className="w-4 h-4 accent-brand-700" />
                  <span className="text-sm text-stone-700">{n.nomeExibicao || formatPhone(n.displayPhone) || `Número #${n.id}`}</span>
                  {n.permiteAtivo !== 'N'
                    ? <span className="text-[9px] px-1 py-0.5 rounded bg-bordeaux-700/10 text-bordeaux-700">ativa</span>
                    : <span className="text-[9px] px-1 py-0.5 rounded bg-stone-100 text-stone-400">receptivo</span>}
                </label>
              ))}
            </div>
            <p className="text-[11px] text-stone-400 mt-1">
              <b>Nenhum marcado = acessa todos.</b> Marque para restringir — ex.: só o número de cobrança ativa,
              ou só o receptivo. Vale para a fila (o que recebe) e para o envio.
            </p>
          </div>
          <label className="flex items-center gap-2.5 cursor-pointer">
            <input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} className="w-4 h-4 accent-brand-700" />
            <span className="text-sm text-stone-700">Usuário ativo</span>
          </label>
          <label className={`flex items-start gap-2.5 ${papel === 'ADMIN' ? 'cursor-default' : 'cursor-pointer'}`}>
            <input type="checkbox"
              checked={papel === 'ADMIN' ? true : podeAtivo}
              disabled={papel === 'ADMIN'}
              onChange={(e) => setPodeAtivo(e.target.checked)}
              className="w-4 h-4 mt-0.5 accent-bordeaux-700 disabled:opacity-60" />
            <span className="text-sm text-stone-700">
              Pode iniciar <span className="font-semibold">conversa ativa</span> (cobrança/disparo de template)
              {papel === 'ADMIN'
                ? <span className="block text-[11px] text-stone-400">Administradores <b>sempre podem</b> — pra restringir alguém, use o papel SUPERVISOR ou ATENDENTE.</span>
                : <span className="block text-[11px] text-stone-400">Disparo é pago — libere só para quem precisa.</span>}
            </span>
          </label>
          {erro && <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{erro}</div>}
        </div>
        <div className="p-3 border-t border-black/[0.06] flex gap-2 safe-bottom">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-black/20 text-stone-700 font-semibold text-sm">Cancelar</button>
          <button onClick={() => salvar.mutate()} disabled={salvar.isPending}
            className="flex-1 py-2.5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white font-semibold text-sm disabled:opacity-40">
            {salvar.isPending ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Atendentes() {
  const { isAdmin } = useAuth();
  const [editando, setEditando] = useState(null);

  const atendentes = useQuery({
    queryKey: ['atendentes'],
    queryFn: () => api.get('/atendentes').then((r) => r.data),
  });
  const deptos = useQuery({
    queryKey: ['departamentos', 'todos'],
    queryFn: () => api.get('/departamentos', { params: { todos: 1 } }).then((r) => r.data),
  });
  const numeros = useQuery({
    queryKey: ['numeros'],
    queryFn: () => api.get('/numeros').then((r) => r.data),
  });

  const nomeDepto = (id) => (deptos.data || []).find((d) => d.id === id);
  const nomeNum = (id) => (numeros.data || []).find((n) => n.id === id);

  return (
    <div className="max-w-screen-xl mx-auto space-y-4">
      <p className="text-xs text-stone-500">
        Atendentes aparecem aqui automaticamente no primeiro login. Vincule cada um aos departamentos que atende.
      </p>
      <div className="bg-white rounded-2xl border border-black/[0.06] divide-y divide-black/[0.05]">
        {atendentes.isLoading && <div className="p-8 flex justify-center"><Spinner /></div>}
        {atendentes.isError && <p className="p-4 text-sm text-red-600">{atendentes.error.response?.data?.error || 'Erro ao carregar.'}</p>}
        {(atendentes.data || []).map((a) => (
          <div key={a.id} className={`flex items-center gap-3 px-4 py-3 ${a.ativo === 'N' ? 'opacity-50' : ''}`}>
            <div className="w-9 h-9 shrink-0 rounded-full navy-gradient text-white flex items-center justify-center font-mono text-xs">
              {(a.nome || String(a.matricula)).slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-sm text-stone-800 truncate">{a.nome || `Matrícula ${a.matricula}`}</p>
              <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-stone-100 text-stone-500">#{a.matricula}</span>
                <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded
                  ${a.papel === 'ADMIN' ? 'bg-bordeaux-50 text-bordeaux-700' : 'bg-brand-50 text-brand-700'}`}>
                  {a.papel || 'ATENDENTE'}
                </span>
                {(a.podeAtivo === 'S' || a.papel === 'ADMIN') && (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-50 text-amber-700" title="Pode iniciar conversa ativa">⚡ ativa</span>
                )}
                {(a.deptoIds || []).map((id) => {
                  const d = nomeDepto(id);
                  return d ? (
                    <span key={id} className="text-[10px] px-1.5 py-0.5 rounded-full text-white" style={{ backgroundColor: d.cor || '#1B5E7B' }}>
                      {d.nome}
                    </span>
                  ) : null;
                })}
                {(a.numeroIds || []).length > 0 && (a.numeroIds || []).map((id) => {
                  const n = nomeNum(id);
                  return n ? (
                    <span key={`n${id}`} className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-100 text-stone-500" title="Número (canal) que acessa">
                      📞 {n.nomeExibicao || formatPhone(n.displayPhone) || `#${id}`}
                    </span>
                  ) : null;
                })}
              </div>
            </div>
            {isAdmin && (
              <button onClick={() => setEditando(a)}
                className="text-xs px-3 py-1.5 rounded-lg border border-black/15 text-stone-600 hover:bg-paper-50 font-medium">
                Editar
              </button>
            )}
          </div>
        ))}
        {atendentes.data?.length === 0 && (
          <p className="p-6 text-sm text-stone-500 text-center">Nenhum atendente ainda — eles surgem no primeiro login.</p>
        )}
      </div>

      {editando && <Portal><EditarAtendente atd={editando} deptos={deptos.data} numeros={numeros.data} onClose={() => setEditando(null)} /></Portal>}
    </div>
  );
}
