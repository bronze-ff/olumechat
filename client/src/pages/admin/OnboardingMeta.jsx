import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../services/api';
import Spinner from '../../components/ui/Spinner';
import Icon from '../../components/ui/Icon';

// OnboardingMeta.jsx — checklist do onboarding assistido da Meta (FIL-81).
// Só existe dentro de uma sessão de SUPORTE (o backend rejeita qualquer outro
// JWT com 403 — ver server/api/onboardingMeta.js). Nenhuma automação de Graph
// API aqui: é acompanhamento manual de um processo que a Meta exige interação
// humana para concluir.

const STATUS = {
  pendente: { label: 'Pendente', className: 'bg-stone-100 text-stone-700 border-stone-200', dot: 'bg-stone-400' },
  em_andamento: { label: 'Em andamento', className: 'bg-blue-50 text-blue-800 border-blue-200', dot: 'bg-blue-500' },
  concluida: { label: 'Concluída', className: 'bg-emerald-50 text-emerald-800 border-emerald-200', dot: 'bg-emerald-500' },
  bloqueada: { label: 'Bloqueada', className: 'bg-red-50 text-red-800 border-red-200', dot: 'bg-red-500' },
};

function Badge({ status }) {
  const s = STATUS[status] || STATUS.pendente;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px] font-semibold shrink-0 ${s.className}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

function Etapa({ etapa, salvar, pendente }) {
  const [status, setStatus] = useState(etapa.status);
  const [responsavel, setResponsavel] = useState(etapa.responsavel || '');
  const [observacao, setObservacao] = useState(etapa.observacao || '');
  const [dataReferencia, setDataReferencia] = useState(etapa.dataReferencia ? etapa.dataReferencia.slice(0, 10) : '');

  const mudou = status !== etapa.status || responsavel !== (etapa.responsavel || '')
    || observacao !== (etapa.observacao || '') || dataReferencia !== (etapa.dataReferencia ? etapa.dataReferencia.slice(0, 10) : '');

  return (
    <article className="px-5 py-4">
      <div className="flex items-start gap-3">
        <span className="w-7 h-7 rounded-lg bg-paper-200 text-stone-700 flex items-center justify-center text-xs font-semibold shrink-0 mt-0.5">
          {etapa.ordem}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-sm text-ink-950">{etapa.titulo}</h3>
            <Badge status={etapa.status} />
          </div>
          <p className="mt-0.5 text-xs text-stone-500">{etapa.descricao}</p>

          <div className="mt-3 grid sm:grid-cols-2 gap-2.5">
            <div>
              <label className="field-label">Status</label>
              <select className="input-field !min-h-9 !py-1.5" value={status} onChange={(e) => setStatus(e.target.value)}>
                {Object.keys(STATUS).map((k) => <option key={k} value={k}>{STATUS[k].label}</option>)}
              </select>
            </div>
            <div>
              <label className="field-label">Responsável</label>
              <input className="input-field !min-h-9 !py-1.5" value={responsavel} placeholder="Quem está tocando esta etapa"
                onChange={(e) => setResponsavel(e.target.value)} />
            </div>
            <div>
              <label className="field-label">Data de referência</label>
              <input type="date" className="input-field !min-h-9 !py-1.5" value={dataReferencia}
                onChange={(e) => setDataReferencia(e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <label className="field-label">Anotação <span className="font-normal text-stone-500">(protocolo, motivo de recusa da Meta…)</span></label>
              <textarea className="input-field !min-h-9 py-1.5" rows={2} value={observacao}
                onChange={(e) => setObservacao(e.target.value)} />
            </div>
          </div>

          {etapa.atualizadoEm && (
            <p className="mt-2 text-[11px] text-stone-400">
              Última atualização {new Date(etapa.atualizadoEm).toLocaleString('pt-BR')}
              {etapa.atualizadoPor ? ` · ${etapa.atualizadoPor}` : ''}
            </p>
          )}

          <div className="mt-3">
            <button
              disabled={!mudou || pendente}
              onClick={() => salvar({ etapa: etapa.etapa, status, responsavel, observacao, dataReferencia: dataReferencia || null })}
              className="min-h-9 px-3.5 rounded-lg bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Salvar etapa
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

export default function OnboardingMeta() {
  const qc = useQueryClient();
  const [sugestao, setSugestao] = useState(null);

  const etapas = useQuery({
    queryKey: ['onboarding-meta'],
    queryFn: () => api.get('/onboarding-meta').then((r) => r.data),
  });

  const salvar = useMutation({
    mutationFn: ({ etapa, ...corpo }) => api.put(`/onboarding-meta/${etapa}`, corpo).then((r) => r.data),
    onSuccess: (dados) => {
      qc.invalidateQueries({ queryKey: ['onboarding-meta'] });
      if (dados.sugestaoInicioCobranca) setSugestao(dados.sugestaoInicioCobranca);
    },
  });

  if (etapas.isLoading) return <div className="p-10 flex justify-center"><Spinner /></div>;
  if (etapas.isError) return <p className="p-5 text-sm text-red-700">Não foi possível carregar o checklist.</p>;

  const concluidas = (etapas.data || []).filter((e) => e.status === 'concluida').length;
  const total = (etapas.data || []).length;

  return (
    <div className="max-w-screen-md mx-auto space-y-4">
      {sugestao && (
        <section className="app-panel border-emerald-200 overflow-hidden p-4 flex items-start gap-3" role="status">
          <span className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0">
            <Icon name="check" size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-ink-950">Onboarding concluído — sugestão de início de cobrança</p>
            <p className="mt-1 text-xs text-stone-600">
              {sugestao.motivo} Data sugerida: <strong>{new Date(sugestao.data).toLocaleDateString('pt-BR')}</strong>.
              Isto não altera o contrato automaticamente — confirme com o financeiro (FIL-76).
            </p>
          </div>
          <button onClick={() => setSugestao(null)} className="text-xs font-semibold text-stone-500 hover:text-ink-950">Fechar</button>
        </section>
      )}

      <section className="app-panel overflow-hidden">
        <header className="px-5 py-4 flex flex-wrap items-center gap-3 border-b border-paper-300">
          <div className="flex-1">
            <h2 className="font-semibold text-ink-950">Onboarding assistido da Meta</h2>
            <p className="mt-0.5 text-xs text-stone-500">
              Conta, verificação, WABA, número, templates e webhook — acompanhe onde este cliente está parado.
            </p>
          </div>
          <span className="text-xs font-medium text-stone-500">{concluidas}/{total} concluídas</span>
        </header>
        <div className="divide-y divide-paper-300">
          {(etapas.data || []).map((etapa) => (
            <Etapa key={etapa.etapa} etapa={etapa} salvar={salvar.mutate} pendente={salvar.isPending} />
          ))}
        </div>
      </section>
    </div>
  );
}
