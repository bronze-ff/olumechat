import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../services/api';
import Spinner from '../../components/ui/Spinner';
import Confirmar from '../../components/ui/Confirmar';
import Portal from '../../components/ui/Portal';
import { useAuth } from '../../context/AuthContext';
import { formatPhone } from '../../utils/formatters';
import FluxoEditor from './FluxoEditor';

export default function Fluxos() {
  const { isAdmin } = useAuth();
  const [editando, setEditando] = useState(null); // null | 'novo' | fluxoId
  const [excluindo, setExcluindo] = useState(null); // fluxo a confirmar exclusão
  const [erroImport, setErroImport] = useState('');
  const importRef = useRef(null);
  const qc = useQueryClient();

  // Exporta o fluxo como arquivo .json (formato portável mcZapFluxo).
  async function exportar(f) {
    const { data } = await api.get(`/fluxos/${f.id}`);
    const arquivo = { mcZapFluxo: 1, nome: data.nome, definicao: data.definicao };
    const blob = new Blob([JSON.stringify(arquivo, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fluxo-${data.nome.toLowerCase().replace(/[^\w]+/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Importa um .json (wrapper mcZapFluxo OU definição crua) como rascunho.
  async function importar(file) {
    setErroImport('');
    try {
      const txt = await file.text();
      const obj = JSON.parse(txt);
      const definicao = obj.mcZapFluxo ? obj.definicao : (obj.nos ? obj : null);
      if (!definicao || !Array.isArray(definicao.nos)) {
        setErroImport('Arquivo inválido: esperado um JSON de fluxo (exportado daqui ou com {config, nos}).');
        return;
      }
      // Preserva o nome ORIGINAL (sem sufixo) — assim referências entre fluxos
      // por nome (passo "Ir para fluxo") casam direto após importar.
      const nome = obj.nome || file.name.replace(/\.json$/i, '').replace(/^fluxo-/, '').replace(/-/g, ' ');
      const { data } = await api.post('/fluxos', { nome, definicao });
      qc.invalidateQueries({ queryKey: ['fluxos'] });
      setEditando(data.id); // abre pra revisar (deptos/número) antes de ativar
    } catch (e) {
      const det = e.response?.data?.detalhes;
      setErroImport(det ? `Fluxo inválido: ${det.join(' · ')}` : (e.response?.data?.error || 'Falha ao importar (JSON malformado?).'));
    }
  }

  const fluxos = useQuery({
    queryKey: ['fluxos'],
    queryFn: () => api.get('/fluxos').then((r) => r.data),
  });

  const ativar = useMutation({
    mutationFn: ({ id, ativo }) => api.post(`/fluxos/${id}/${ativo ? 'desativar' : 'ativar'}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fluxos'] }),
    onError: (e) => alert(e.response?.data?.error || 'Falha ao alterar o fluxo.'),
  });

  const excluir = useMutation({
    mutationFn: (id) => api.delete(`/fluxos/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fluxos'] }),
    onError: (e) => alert(e.response?.data?.error || 'Falha ao excluir o fluxo.'),
    onSettled: () => setExcluindo(null),
  });

  function confirmarExclusao(f) {
    if (f.ativo === 'S') { alert('Esse fluxo está ATIVO — desative antes de excluir.'); return; }
    setExcluindo(f);
  }

  return (
    <div className="max-w-screen-xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-stone-500 flex-1">
          O fluxo <span className="font-semibold">ativo</span> de um número atende automaticamente
          as conversas novas — menus, perguntas e transferência para a fila do departamento.
        </p>
        {isAdmin && (
          <div className="shrink-0 flex gap-2">
            <input ref={importRef} type="file" accept=".json,application/json" className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importar(f);
                e.target.value = '';
              }} />
            <button onClick={() => importRef.current?.click()}
              className="px-4 py-2 rounded-xl border border-black/15 text-stone-600 hover:bg-paper-50 text-sm font-semibold">
              ⬆ Importar
            </button>
            <button onClick={() => setEditando('novo')}
              className="px-4 py-2 rounded-xl bg-bordeaux-700 hover:bg-bordeaux-800 text-white text-sm font-semibold">
              + Novo fluxo
            </button>
          </div>
        )}
      </div>

      {erroImport && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">{erroImport}</p>
      )}

      {fluxos.isLoading && <div className="p-10 flex justify-center"><Spinner /></div>}
      {fluxos.isError && <p className="p-4 text-sm text-red-600">{fluxos.error.response?.data?.error || 'Erro ao carregar.'}</p>}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {(fluxos.data || []).map((f) => (
          <div key={f.id}
            className={`relative bg-white rounded-2xl border p-4 overflow-hidden
              ${f.ativo === 'S' ? 'border-emerald-300 ring-1 ring-emerald-100' : 'border-black/[0.06]'}`}>
            <div className="flex items-start gap-2.5 mb-3">
              <span className="text-xl leading-none mt-0.5">🤖</span>
              <div className="min-w-0 flex-1">
                <p className="font-display font-bold text-[15px] text-stone-800 truncate">{f.nome}</p>
                <p className="font-mono text-[10px] text-stone-400 mt-0.5">
                  {f.numeroId
                    ? (f.nomeExibicao || formatPhone(f.displayPhone) || `nº ${f.numeroId}`)
                    : 'sem número vinculado'} · v{f.versao}
                </p>
              </div>
              <span className={`shrink-0 font-mono text-[9px] uppercase tracking-widest px-2 py-1 rounded-full
                ${f.ativo === 'S' ? 'bg-emerald-100 text-emerald-700' : 'bg-stone-100 text-stone-400'}`}>
                {f.ativo === 'S' ? '● ativo' : 'inativo'}
              </span>
            </div>
            {isAdmin && (
              <div className="flex gap-2">
                <button onClick={() => setEditando(f.id)}
                  className="flex-1 text-xs py-2 rounded-lg border border-black/15 text-stone-600 hover:bg-paper-50 font-medium">
                  Editar
                </button>
                <button onClick={() => exportar(f)} title="Baixar o fluxo como .json"
                  className="text-xs px-3 py-2 rounded-lg border border-black/15 text-stone-600 hover:bg-paper-50 font-medium"
                  aria-label="Exportar fluxo">
                  ⬇
                </button>
                <button onClick={() => confirmarExclusao(f)} title="Excluir fluxo" disabled={excluir.isPending}
                  className="text-xs px-3 py-2 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 font-medium disabled:opacity-40"
                  aria-label="Excluir fluxo">
                  🗑
                </button>
                <button onClick={() => ativar.mutate({ id: f.id, ativo: f.ativo === 'S' })}
                  className={`flex-1 text-xs py-2 rounded-lg font-medium transition-colors
                    ${f.ativo === 'S'
                      ? 'bg-stone-100 text-stone-500 hover:bg-stone-200'
                      : 'bg-emerald-600 text-white hover:bg-emerald-700'}`}>
                  {f.ativo === 'S' ? 'Desativar' : 'Ativar'}
                </button>
              </div>
            )}
          </div>
        ))}
        {fluxos.data?.length === 0 && (
          <div className="col-span-full bg-white rounded-2xl border border-dashed border-black/15 p-10 text-center">
            <p className="text-3xl mb-2">🤖</p>
            <p className="text-sm text-stone-500">Nenhum fluxo ainda — crie o primeiro para automatizar a triagem do atendimento.</p>
          </div>
        )}
      </div>

      {editando !== null && (
        <Portal>
          <FluxoEditor
            fluxoId={editando === 'novo' ? null : editando}
            onClose={() => setEditando(null)}
            onSaved={() => { setEditando(null); qc.invalidateQueries({ queryKey: ['fluxos'] }); }}
          />
        </Portal>
      )}

      {excluindo && (
        <Confirmar
          titulo="Excluir fluxo"
          mensagem={`Excluir o fluxo "${excluindo.nome}"? Essa ação não tem volta.`}
          dica="Dica: exporte antes (⬇) se quiser guardar uma cópia."
          confirmarTexto="Excluir"
          perigo
          pendente={excluir.isPending}
          onConfirmar={() => excluir.mutate(excluindo.id)}
          onCancelar={() => setExcluindo(null)}
        />
      )}
    </div>
  );
}
