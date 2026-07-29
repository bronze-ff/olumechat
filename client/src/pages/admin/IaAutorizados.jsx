import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../services/api';
import Spinner from '../../components/ui/Spinner';
import Confirmar from '../../components/ui/Confirmar';
import { useAuth } from '../../context/AuthContext';
import { formatPhone } from '../../utils/formatters';

// Telefones que podem conversar com o bot de IA ENQUANTO o canal estiver em
// modo teste (FIL-88) — é a lista do modo teste, não um controle de acesso
// permanente. O backend devolve as colunas em MAIÚSCULO (ID, TELEFONE, NOME,
// NUMERO_ID, ATIVO) — diferente das outras telas.
export default function IaAutorizados() {
  const { isAdmin, user } = useAuth();
  const [telefone, setTelefone] = useState('');
  const [numeroId, setNumeroId] = useState('');
  const [nome, setNome] = useState('');
  const [erro, setErro] = useState('');
  const [removendo, setRemovendo] = useState(null);
  const qc = useQueryClient();

  const autorizados = useQuery({
    queryKey: ['ia-autorizados'],
    queryFn: () => api.get('/ia-autorizados').then((r) => r.data),
    enabled: !!user?.iaHabilitada,
  });
  // Números da empresa (canais) — para escolher em qual número o telefone fala com o bot.
  const numeros = useQuery({
    queryKey: ['numeros-lista'],
    queryFn: () => api.get('/numeros/lista').then((r) => r.data),
    staleTime: 5 * 60_000,
    enabled: !!user?.iaHabilitada,
  });
  // Lista completa (com modo/iaModoTeste) só para o estado contextual do topo —
  // a /numeros/lista acima não devolve essas colunas.
  const canais = useQuery({
    queryKey: ['numeros', 'canais-ia'],
    queryFn: () => api.get('/numeros').then((r) => r.data),
    staleTime: 60_000,
    enabled: !!user?.iaHabilitada,
  });
  const canaisComIa = (canais.data || []).filter((n) => n.modo === 'ia');
  const algumEmTeste = canaisComIa.some((n) => n.iaModoTeste === 'S');
  const rotuloNumero = (id) => {
    const n = (numeros.data || []).find((x) => x.id === id);
    return n ? (n.nomeExibicao || formatPhone(n.displayPhone) || `Número #${id}`) : `Número #${id}`;
  };

  const criar = useMutation({
    mutationFn: () => api.post('/ia-autorizados', {
      telefone: telefone.replace(/\D/g, ''), numeroId: Number(numeroId), nome: nome.trim() || undefined,
    }),
    onSuccess: () => { setTelefone(''); setNome(''); setErro(''); qc.invalidateQueries({ queryKey: ['ia-autorizados'] }); },
    onError: (e) => setErro(e.response?.data?.error || 'Falha ao autorizar.'),
  });

  const remover = useMutation({
    mutationFn: (id) => api.delete(`/ia-autorizados/${id}`),
    onSuccess: () => { setRemovendo(null); qc.invalidateQueries({ queryKey: ['ia-autorizados'] }); },
    onError: () => setRemovendo(null),
  });

  const telOk = telefone.replace(/\D/g, '').length >= 10;
  const podeCriar = telOk && numeroId && !criar.isPending;
  const lista = autorizados.data || [];

  if (!user?.iaHabilitada) {
    return (
      <div className="bg-white rounded-2xl border border-black/[0.06] p-4">
        <p className="text-sm font-medium text-stone-800">Não incluído no seu plano</p>
        <p className="mt-1 text-xs leading-relaxed text-stone-500 max-w-[54ch]">
          O agente de IA é um recurso vendido à parte. Fale com o time Falatta para adicionar ao seu plano.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-screen-xl mx-auto grid grid-cols-12 gap-4 items-start">
      <div className="col-span-12 bg-white rounded-2xl border border-black/[0.06] p-4 space-y-3">
        <p className="text-sm text-stone-600 leading-relaxed max-w-[70ch]">
          Só telefones desta lista conversam com o agente <b>enquanto o canal estiver em modo teste</b>.
          Com o modo teste desligado, o agente atende qualquer cliente e esta lista é ignorada.
        </p>

        {canais.isLoading && <div className="flex justify-center py-1"><Spinner /></div>}

        {canais.isError && (
          <p className="text-xs text-red-600">Não foi possível carregar o estado dos canais.</p>
        )}

        {!canais.isLoading && !canais.isError && canaisComIa.length === 0 && (
          <p className="text-xs text-stone-400">Nenhum canal tem o agente de IA ligado ainda.</p>
        )}

        {!canais.isLoading && !canais.isError && canaisComIa.length > 0 && (
          <>
            <div className="flex flex-wrap gap-2">
              {canaisComIa.map((n) => (
                <span key={n.id} className={`text-[11px] px-2.5 py-1 rounded-full border ${
                  n.iaModoTeste === 'S' ? 'bg-brand-50 border-brand-100 text-brand-700' : 'bg-stone-50 border-stone-200 text-stone-500'
                }`}>
                  {n.nomeExibicao || formatPhone(n.displayPhone) || `Número #${n.id}`} · {n.iaModoTeste === 'S' ? 'em modo teste' : 'modo teste desligado'}
                </span>
              ))}
            </div>
            {!algumEmTeste && (
              <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2.5">
                Nenhum canal está em modo teste — esta lista não está em uso.
              </p>
            )}
          </>
        )}
      </div>

      {isAdmin && (
        <form onSubmit={(e) => { e.preventDefault(); if (podeCriar) criar.mutate(); }}
          className="col-span-12 lg:col-span-4 lg:sticky lg:top-32 bg-white rounded-2xl border border-black/[0.06] p-4 space-y-3">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Telefone (com DDI)</label>
            <input className="input-field font-mono" value={telefone} inputMode="numeric"
              onChange={(e) => { setTelefone(e.target.value); setErro(''); }} placeholder="Ex.: 5562999990000" />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Número do bot (canal)</label>
            <select className="input-field" value={numeroId} onChange={(e) => setNumeroId(e.target.value)}>
              <option value="">Selecione…</option>
              {(numeros.data || []).map((n) => (
                <option key={n.id} value={n.id}>{n.nomeExibicao || formatPhone(n.displayPhone) || `Número #${n.id}`}</option>
              ))}
            </select>
            <p className="text-[11px] text-stone-400 mt-1">O número (MODO=ia) pelo qual esse telefone conversa com a IA.</p>
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Nome (opcional)</label>
            <input className="input-field" value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: Filippe (Diretoria)" />
          </div>
          {erro && <p className="text-xs text-red-600">{erro}</p>}
          <button type="submit" disabled={!podeCriar}
            className="w-full py-2.5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-sm font-semibold disabled:opacity-40">
            {criar.isPending ? 'Autorizando…' : 'Autorizar telefone'}
          </button>
        </form>
      )}

      <div className={`${isAdmin ? 'col-span-12 lg:col-span-8' : 'col-span-12'} bg-white rounded-2xl border border-black/[0.06] divide-y divide-black/[0.05]`}>
        {autorizados.isLoading && <div className="p-8 flex justify-center"><Spinner /></div>}
        {autorizados.isError && <p className="p-4 text-sm text-red-600">Erro ao carregar.</p>}
        {lista.map((a) => (
          <div key={a.ID} className={`flex items-center gap-3 px-4 py-3 ${a.ATIVO === 'N' ? 'opacity-50' : ''}`}>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-sm text-stone-800">{a.NOME || formatPhone(a.TELEFONE) || a.TELEFONE}</p>
              <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                <span className="text-[11px] font-mono text-stone-400">{formatPhone(a.TELEFONE) || a.TELEFONE}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-brand-50 text-brand-700">via {rotuloNumero(a.NUMERO_ID)}</span>
                {a.ATIVO === 'N' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-stone-100 text-stone-400">removido</span>}
              </div>
            </div>
            {isAdmin && a.ATIVO === 'S' && (
              <button onClick={() => setRemovendo(a)}
                className="text-xs px-3 py-1.5 rounded-lg border border-black/15 text-red-600 hover:bg-red-50 font-medium">
                Remover
              </button>
            )}
          </div>
        ))}
        {lista.length === 0 && !autorizados.isLoading && (
          <p className="p-6 text-sm text-stone-500 text-center">Nenhum telefone autorizado. Só telefones desta lista conversam com o bot de IA.</p>
        )}
      </div>

      {removendo && (
        <Confirmar
          titulo="Remover autorização"
          mensagem={`Tirar o acesso ao bot de IA de ${removendo.NOME || formatPhone(removendo.TELEFONE) || removendo.TELEFONE}?`}
          dica="Você pode reautorizar depois pelo formulário. O bot para de responder a esse telefone na hora."
          confirmarTexto="Remover" perigo pendente={remover.isPending}
          onConfirmar={() => remover.mutate(removendo.ID)}
          onCancelar={() => setRemovendo(null)} />
      )}
    </div>
  );
}
