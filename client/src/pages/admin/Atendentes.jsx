import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../services/api';
import Spinner from '../../components/ui/Spinner';
import Portal from '../../components/ui/Portal';
import Confirmar from '../../components/ui/Confirmar';
import Icon from '../../components/ui/Icon';
import { useAuth } from '../../context/AuthContext';
import { formatPhone } from '../../utils/formatters';

const PAPEIS = ['ADMIN', 'SUPERVISOR', 'ATENDENTE', 'AUDITOR'];

// Link de convite (criação ou reset de senha): quem define a senha é o
// PRÓPRIO usuário ao abrir o link — o admin nunca digita a senha de ninguém.
// Link de uso único; se fechar sem copiar, "Resetar senha" gera outro.
function ConviteModal({ convite, onClose }) {
  const [copiado, setCopiado] = useState(false);
  const copiar = async () => {
    await navigator.clipboard?.writeText(convite.link);
    setCopiado(true);
  };
  return (
    <Portal>
      <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center" role="dialog" aria-modal="true">
        <div className="absolute inset-0 bg-black/60" onClick={onClose} />
        <div className="relative w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl overflow-hidden animate-slide-up">
          <div className="navy-gradient text-white px-4 py-3 flex items-center gap-2">
            <span className="section-bar" />
            <h2 className="font-display font-bold text-base flex-1">Envie este link ao usuário</h2>
            <button onClick={onClose} className="text-white/70 hover:text-white" aria-label="Fechar">✕</button>
          </div>
          <div className="p-4 space-y-3">
            <p className="text-sm text-stone-700">
              O usuário define a própria senha ao abrir o link. Funciona uma única vez e expira em{' '}
              {new Date(convite.expiraEm).toLocaleString('pt-BR')}.
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <code className="min-w-0 flex-1 px-3 py-2.5 rounded-lg bg-paper-100 border border-paper-300 text-xs text-stone-700 break-all">
                {convite.link}
              </code>
              <button onClick={copiar} className="min-h-10 px-4 rounded-lg bg-ink-900 hover:bg-ink-950 text-white text-sm font-semibold inline-flex items-center justify-center gap-2 shrink-0">
                <Icon name={copiado ? 'check' : 'copy'} size={16} />
                {copiado ? 'Link copiado' : 'Copiar link'}
              </button>
            </div>
          </div>
          <div className="modal-footer">
            <button onClick={onClose} className="w-full py-2.5 rounded-xl border border-black/20 text-stone-700 font-semibold text-sm">Fechar</button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

function NovoAtendenteModal({ deptos, numeros, onClose, onCriado }) {
  const [email, setEmail] = useState('');
  const [nome, setNome] = useState('');
  const [papel, setPapel] = useState('ATENDENTE');
  const [podeAtivo, setPodeAtivo] = useState(false);
  const [sel, setSel] = useState(new Set());
  const [selNum, setSelNum] = useState(new Set());
  const [erro, setErro] = useState('');
  const qc = useQueryClient();

  const criar = useMutation({
    mutationFn: () => api.post('/atendentes', {
      email: email.trim(), nome: nome.trim() || undefined, papel,
      podeAtivo: podeAtivo ? 'S' : 'N', deptoIds: [...sel], numeroIds: [...selNum],
    }).then((r) => r.data),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['atendentes'] });
      onCriado(data.convite);
    },
    onError: (e) => setErro(e.response?.data?.error || 'Falha ao criar o atendente.'),
  });

  const toggleDepto = (id) => setSel((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleNum = (id) => setSelNum((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());

  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true">
        <div className="absolute inset-0 bg-black/60" onClick={onClose} />
        <div className="relative w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl overflow-hidden max-h-[92vh] flex flex-col">
          <div className="navy-gradient text-white px-4 py-3 flex items-center gap-2">
            <span className="section-bar" />
            <h2 className="font-display font-bold text-base flex-1">Novo atendente</h2>
            <button onClick={onClose} className="text-white/70 hover:text-white" aria-label="Fechar">✕</button>
          </div>
          <div className="modal-body space-y-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">E-mail de acesso</label>
              <input type="email" className="input-field" value={email} autoCapitalize="none" spellCheck="false"
                onChange={(e) => { setEmail(e.target.value); setErro(''); }} placeholder="ana@suaempresa.com.br" />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Nome <span className="font-normal text-stone-400">(opcional)</span></label>
              <input className="input-field" value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ana Martins" />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Papel</label>
              <select className="input-field" value={papel} onChange={(e) => setPapel(e.target.value)}>
                {PAPEIS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Departamentos (filas que atende)</label>
              <div className="space-y-1">
                {(deptos || []).filter((d) => d.ativo === 'S').map((d) => (
                  <label key={d.id} className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-paper-50 cursor-pointer">
                    <input type="checkbox" checked={sel.has(d.id)} onChange={() => toggleDepto(d.id)} className="w-4 h-4 accent-brand-700" />
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: d.cor || '#1F7A60' }} />
                    <span className="text-sm text-stone-700">{d.nome}</span>
                  </label>
                ))}
                {(deptos || []).filter((d) => d.ativo === 'S').length === 0 && (
                  <p className="text-xs text-stone-400">Cadastre um departamento primeiro.</p>
                )}
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Números que acessa (canais)</label>
              <div className="space-y-1">
                {(numeros || []).filter((n) => n.ativo !== 'N').map((n) => (
                  <label key={n.id} className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-paper-50 cursor-pointer">
                    <input type="checkbox" checked={selNum.has(n.id)} onChange={() => toggleNum(n.id)} className="w-4 h-4 accent-brand-700" />
                    <span className="text-sm text-stone-700">{n.nomeExibicao || formatPhone(n.displayPhone) || `Número #${n.id}`}</span>
                  </label>
                ))}
              </div>
              <p className="text-[11px] text-stone-400 mt-1">Nenhum marcado = acessa todos.</p>
            </div>
            <label className={`flex items-start gap-2.5 ${papel === 'ADMIN' ? 'cursor-default' : 'cursor-pointer'}`}>
              <input type="checkbox" checked={papel === 'ADMIN' ? true : podeAtivo} disabled={papel === 'ADMIN'}
                onChange={(e) => setPodeAtivo(e.target.checked)} className="w-4 h-4 mt-0.5 accent-bordeaux-700 disabled:opacity-60" />
              <span className="text-sm text-stone-700">
                Pode iniciar <span className="font-semibold">conversa ativa</span> (cobrança/disparo de template)
              </span>
            </label>
            {erro && <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{erro}</div>}
          </div>
          <div className="modal-footer">
            <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-black/20 text-stone-700 font-semibold text-sm">Cancelar</button>
            <button onClick={() => criar.mutate()} disabled={!emailOk || criar.isPending}
              className="flex-1 py-2.5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white font-semibold text-sm disabled:opacity-40">
              {criar.isPending ? 'Criando…' : 'Criar e gerar link'}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

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
        <div className="modal-body space-y-4">
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
                  <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: d.cor || '#1F7A60' }} />
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
        <div className="modal-footer">
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
  const { isAdmin, user } = useAuth();
  const [editando, setEditando] = useState(null);
  const [criando, setCriando] = useState(false);
  const [convite, setConvite] = useState(null);
  const [confirmacao, setConfirmacao] = useState(null);
  const [erro, setErro] = useState('');
  const qc = useQueryClient();

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

  const resetarSenha = useMutation({
    mutationFn: (id) => api.post(`/atendentes/${id}/resetar-senha`).then((r) => r.data),
    onSuccess: (data) => { setErro(''); setConvite(data.convite); },
    onError: (e) => setErro(e.response?.data?.error || 'Falha ao gerar o link.'),
  });
  const alterarAtivo = useMutation({
    mutationFn: ({ id, ativo }) => api.put(`/atendentes/${id}`, { ativo }),
    onSuccess: () => { setErro(''); setConfirmacao(null); qc.invalidateQueries({ queryKey: ['atendentes'] }); },
    onError: (e) => { setConfirmacao(null); setErro(e.response?.data?.error || 'Falha ao alterar.'); },
  });

  const nomeDepto = (id) => (deptos.data || []).find((d) => d.id === id);
  const nomeNum = (id) => (numeros.data || []).find((n) => n.id === id);

  return (
    <div className="max-w-screen-xl mx-auto space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-stone-500 max-w-[60ch]">
          Cadastre quem trabalha na sua empresa: e-mail, papel, departamentos que atende e se pode iniciar conversa ativa.
        </p>
        {isAdmin && (
          <button onClick={() => setCriando(true)}
            className="shrink-0 min-h-9 px-3.5 rounded-lg bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold inline-flex items-center gap-1.5">
            <Icon name="plus" size={15} />
            Novo atendente
          </button>
        )}
      </div>
      {erro && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-start gap-2">
          <span className="flex-1">{erro}</span>
          <button onClick={() => setErro('')} className="font-semibold" aria-label="Fechar aviso">✕</button>
        </div>
      )}
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
                    <span key={id} className="text-[10px] px-1.5 py-0.5 rounded-full text-white" style={{ backgroundColor: d.cor || '#1F7A60' }}>
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
              <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                <button onClick={() => setEditando(a)}
                  className="text-xs px-3 py-1.5 rounded-lg border border-black/15 text-stone-600 hover:bg-paper-50 font-medium">
                  Editar
                </button>
                <button onClick={() => resetarSenha.mutate(a.id)} disabled={resetarSenha.isPending}
                  title="Gera um novo link de definir senha para enviar ao usuário"
                  className="text-xs px-3 py-1.5 rounded-lg border border-black/15 text-stone-600 hover:bg-paper-50 font-medium disabled:opacity-50">
                  Resetar senha
                </button>
                {a.matricula !== user?.matricula && (
                  a.ativo === 'N' ? (
                    <button onClick={() => alterarAtivo.mutate({ id: a.id, ativo: 'S' })}
                      className="text-xs px-3 py-1.5 rounded-lg text-emerald-800 bg-emerald-50 hover:bg-emerald-100 font-medium">
                      Reativar
                    </button>
                  ) : (
                    <button onClick={() => setConfirmacao(a)}
                      className="text-xs px-3 py-1.5 rounded-lg text-red-700 bg-red-50 hover:bg-red-100 font-medium">
                      Remover
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        ))}
        {atendentes.data?.length === 0 && (
          <p className="p-6 text-sm text-stone-500 text-center">Nenhum atendente ainda — clique em "Novo atendente" para cadastrar o primeiro.</p>
        )}
      </div>

      {editando && <Portal><EditarAtendente atd={editando} deptos={deptos.data} numeros={numeros.data} onClose={() => setEditando(null)} /></Portal>}
      {criando && (
        <NovoAtendenteModal
          deptos={deptos.data} numeros={numeros.data}
          onClose={() => setCriando(false)}
          onCriado={(dadosConvite) => { setCriando(false); setConvite(dadosConvite); }}
        />
      )}
      {convite && <ConviteModal convite={convite} onClose={() => setConvite(null)} />}
      {confirmacao && (
        <Confirmar
          titulo="Remover atendente"
          mensagem={`Remover "${confirmacao.nome || `Matrícula ${confirmacao.matricula}`}"?`}
          dica="A pessoa perde o acesso ao sistema imediatamente. Você pode reativar depois."
          confirmarTexto="Remover" perigo pendente={alterarAtivo.isPending}
          onConfirmar={() => alterarAtivo.mutate({ id: confirmacao.id, ativo: 'N' })}
          onCancelar={() => setConfirmacao(null)}
        />
      )}
    </div>
  );
}
