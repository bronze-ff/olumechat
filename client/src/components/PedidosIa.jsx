import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../services/api';
import Spinner from './ui/Spinner';
import Icon from './ui/Icon';
import { useAuth } from '../context/AuthContext';
import { formatDateTime } from '../utils/formatters';

// FIL-85 — os pedidos que o agente de IA registrou, para uma pessoa conferir.
//
// A MESMA lista serve dois lugares (é por isso que é um componente e não uma
// página): a seção "Pedidos" do atendimento (carteira toda, filtro por status)
// e o atalho dentro de uma conversa (`conversaId`, só os dela). Duplicar a
// tela duplicaria a regra de conferir/descartar.
//
// Nada aqui é enviado para sistema externo: conferir é o registro de que uma
// pessoa olhou e o pedido vale. Descartar guarda o motivo.

const STATUS = [
  { id: 'rascunho', rotulo: 'A conferir' },
  { id: 'conferido', rotulo: 'Conferidos' },
  { id: 'descartado', rotulo: 'Descartados' },
];

const BADGE_STATUS = {
  rascunho: 'bg-amber-50 text-amber-800 border-amber-200',
  conferido: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  descartado: 'bg-stone-100 text-stone-500 border-black/[0.08]',
};

function Pedido({ pedido, podeAgir, onConferir, onDescartar, ocupado }) {
  const [descartando, setDescartando] = useState(false);
  const [motivo, setMotivo] = useState('');

  return (
    <article className="rounded-xl border border-black/[0.08] bg-white p-3.5 space-y-2.5">
      <header className="flex items-start gap-2">
        <span className="w-8 h-8 rounded-lg bg-brand-50 text-brand-800 flex items-center justify-center shrink-0">
          <Icon name="contract" size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink-950 truncate">{pedido.titulo}</p>
          <p className="text-[11px] text-stone-500 truncate">
            {pedido.contatoNome || pedido.contatoTelefone || 'Contato sem nome'}
            {pedido.protocolo ? ` · protocolo ${pedido.protocolo}` : ''}
          </p>
        </div>
        <span className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded border shrink-0 ${BADGE_STATUS[pedido.status]}`}>
          {pedido.status}
        </span>
      </header>

      {/* Os rótulos vêm do PAYLOAD do pedido, não do formulário atual: se a
          empresa editar o formulário depois, o pedido antigo continua legível
          exatamente como foi registrado. */}
      <dl className="grid grid-cols-[minmax(0,9rem)_1fr] gap-x-3 gap-y-1">
        {pedido.campos.map((c) => (
          <div key={c.nome} className="contents">
            <dt className="text-[11px] uppercase tracking-wide text-stone-500 truncate">{c.rotulo}</dt>
            <dd className="text-xs text-stone-800 break-words">{String(c.valor ?? '—')}</dd>
          </div>
        ))}
      </dl>

      <p className="text-[11px] text-stone-400">
        Registrado pela IA em {formatDateTime(pedido.criadoEm)}
        {pedido.conferidoEm && ` · ${pedido.status} por ${pedido.conferidoPor || 'equipe'} em ${formatDateTime(pedido.conferidoEm)}`}
      </p>
      {pedido.observacao && <p className="text-xs text-stone-600">Observação: {pedido.observacao}</p>}

      {podeAgir && pedido.status === 'rascunho' && (
        descartando ? (
          <div className="space-y-2">
            <input value={motivo} maxLength={500} autoFocus
              placeholder="Motivo do descarte (opcional)"
              onChange={(e) => setMotivo(e.target.value)}
              className="input-field text-xs" />
            <div className="flex items-center gap-3">
              <button type="button" onClick={() => onDescartar(motivo)} disabled={ocupado}
                className="px-4 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold disabled:opacity-40">
                Confirmar descarte
              </button>
              <button type="button" onClick={() => { setDescartando(false); setMotivo(''); }}
                className="text-xs text-stone-500 hover:text-stone-800">Cancelar</button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <button type="button" onClick={onConferir} disabled={ocupado}
              className="px-4 py-1.5 rounded-lg bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold disabled:opacity-40">
              {ocupado ? '…' : 'Conferir'}
            </button>
            <button type="button" onClick={() => setDescartando(true)} disabled={ocupado}
              className="text-xs text-stone-500 hover:text-red-600 disabled:opacity-40">Descartar</button>
          </div>
        )
      )}
    </article>
  );
}

export default function PedidosIa({ conversaId = null }) {
  const { user } = useAuth();
  const [status, setStatus] = useState('rascunho');
  const [erro, setErro] = useState('');
  const qc = useQueryClient();
  // AUDITOR é somente-leitura em todo o produto (o backend também recusa).
  const podeAgir = ['ADMIN', 'SUPERVISOR', 'ATENDENTE'].includes(user?.papel);

  const pedidos = useQuery({
    queryKey: ['ia-pedidos', status, conversaId || 'todas'],
    queryFn: () => api.get('/ia-pedidos', {
      params: { status, ...(conversaId ? { conversaId } : {}) },
    }).then((r) => r.data),
    enabled: !!user?.iaHabilitada,
    refetchInterval: 60000, // fallback; o tempo-real vem do SSE
  });

  const decidir = useMutation({
    mutationFn: ({ id, acao, observacao }) => api.post(`/ia-pedidos/${id}/${acao}`, { observacao }),
    onSuccess: () => { setErro(''); qc.invalidateQueries({ queryKey: ['ia-pedidos'] }); },
    onError: (e) => {
      setErro(e.response?.data?.error || 'Falha ao registrar a decisão.');
      // 409 = outra pessoa decidiu antes. Recarrega para a tela contar a verdade.
      qc.invalidateQueries({ queryKey: ['ia-pedidos'] });
    },
  });

  if (!user?.iaHabilitada) {
    return (
      <div className="p-8 text-center text-xs text-stone-500">
        O agente de IA não está incluído no plano desta empresa.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {!conversaId && (
        <div className="flex gap-1 bg-stone-100 rounded-lg p-0.5">
          {STATUS.map((s) => (
            <button key={s.id} type="button" onClick={() => setStatus(s.id)}
              className={`flex-1 py-1 text-[11px] rounded-md font-medium transition-colors
                ${status === s.id ? 'bg-white text-brand-700 shadow-sm' : 'text-stone-500 hover:text-stone-700'}`}>
              {s.rotulo}
            </button>
          ))}
        </div>
      )}

      {erro && <p className="text-xs text-red-600">{erro}</p>}
      {pedidos.isLoading && <div className="p-8 flex justify-center"><Spinner /></div>}
      {pedidos.isError && <p className="text-sm text-red-600">Não foi possível carregar os pedidos.</p>}

      {pedidos.data?.length === 0 && (
        <div className="px-6 py-10 text-center">
          <span className="mx-auto w-10 h-10 rounded-xl bg-paper-200 text-stone-500 flex items-center justify-center">
            <Icon name="contract" size={19} />
          </span>
          <p className="mt-3 text-sm font-semibold text-ink-950">
            {status === 'rascunho' ? 'Nenhum pedido a conferir' : 'Nada por aqui'}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-stone-600">
            Os pedidos que o agente de IA registrar durante o atendimento aparecem aqui para você conferir.
          </p>
        </div>
      )}

      <div className="space-y-2">
        {(pedidos.data || []).map((p) => (
          <Pedido key={p.id} pedido={p} podeAgir={podeAgir}
            ocupado={decidir.isPending}
            onConferir={() => decidir.mutate({ id: p.id, acao: 'conferir' })}
            onDescartar={(observacao) => decidir.mutate({ id: p.id, acao: 'descartar', observacao })} />
        ))}
      </div>
    </div>
  );
}
