import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiOperador, { CHAVE_TOKEN } from '../../services/apiOperador';
import Spinner from '../../components/ui/Spinner';
import Icon from '../../components/ui/Icon';
import OperadorShell from '../../components/layout/OperadorShell';
import { SECOES, GRUPOS } from './nav';

// Leads comerciais da landing (FIL-96) — página própria, no mesmo padrão de
// Contratos.jsx: shell compartilhado, sem passar pelo switch de `secao` do
// Operador.jsx (a tela não tem nada em comum com carteira de clientes).
const STATUS = {
  novo: { label: 'Novo', className: 'bg-brand-50 text-brand-800 border-brand-200', dot: 'bg-brand-500' },
  contatado: { label: 'Contatado', className: 'bg-emerald-50 text-emerald-800 border-emerald-200', dot: 'bg-emerald-500' },
  descartado: { label: 'Descartado', className: 'bg-stone-100 text-stone-700 border-stone-200', dot: 'bg-stone-400' },
};

function StatusLead({ value }) {
  const s = STATUS[value] || STATUS.novo;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px] font-semibold ${s.className}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

export default function Leads() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [filtro, setFiltro] = useState('');
  const [observando, setObservando] = useState(null); // { id, observacao }

  const eu = useQuery({ queryKey: ['operador', 'eu'], queryFn: () => apiOperador.get('/eu').then((r) => r.data) });
  const leads = useQuery({
    queryKey: ['operador', 'leads', filtro],
    queryFn: () => apiOperador.get('/leads', { params: filtro ? { status: filtro } : {} }).then((r) => r.data),
  });

  const atualizar = useMutation({
    mutationFn: ({ id, status, observacao }) => apiOperador.patch(`/leads/${id}`, { status, observacao }).then((r) => r.data),
    onSuccess: () => {
      setObservando(null);
      qc.invalidateQueries({ queryKey: ['operador', 'leads'] });
      qc.invalidateQueries({ queryKey: ['operador', 'leads', 'contagem-novos'] });
    },
  });

  async function sair() {
    try { await apiOperador.post('/logout'); } catch { /* encerra a sessão local mesmo sem resposta */ }
    localStorage.removeItem(CHAVE_TOKEN);
    navigate('/operador/login', { replace: true });
  }

  const lista = leads.data || [];
  const atual = SECOES.find((item) => item.id === 'leads');

  return (
    <OperadorShell
      secoes={SECOES}
      grupos={GRUPOS}
      atual={atual}
      eu={eu}
      onSair={sair}
      titulo="Leads"
      descricao="Solicitações de demonstração recebidas pelo formulário da landing."
      acao={
        <button
          onClick={() => qc.invalidateQueries({ queryKey: ['operador', 'leads'] })}
          className="min-h-10 px-4 rounded-lg border border-paper-400 bg-white hover:bg-paper-100 text-stone-700 text-sm font-semibold inline-flex items-center gap-2"
        >
          <Icon name="history" size={16} />
          Atualizar
        </button>
      }
    >
      <section className="app-panel overflow-hidden">
        <header className="px-5 py-4 flex flex-wrap items-center gap-3 border-b border-paper-300">
          <div className="flex-1">
            <h2 className="font-semibold text-ink-950">Leads recebidos</h2>
            <p className="mt-0.5 text-xs text-stone-500">{lista.length} {lista.length === 1 ? 'lead' : 'leads'}</p>
          </div>
          <select className="min-h-10 text-xs border border-paper-400 rounded-lg px-3 bg-white text-stone-700" value={filtro} onChange={(e) => setFiltro(e.target.value)}>
            <option value="">Todos os status</option>
            <option value="novo">Novo</option>
            <option value="contatado">Contatado</option>
            <option value="descartado">Descartado</option>
          </select>
        </header>

        {leads.isLoading && <div className="p-12 flex justify-center"><Spinner /></div>}
        {leads.isError && <p className="p-5 text-sm text-red-700">Não foi possível carregar os leads.</p>}

        <div className="divide-y divide-paper-300">
          {lista.map((lead) => (
            <article key={lead.id} className="px-5 py-4">
              <div className="flex flex-col lg:flex-row lg:items-start gap-4">
                <div className="min-w-0 lg:w-64 shrink-0">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-sm text-ink-950 truncate">{lead.nome}</p>
                    <StatusLead value={lead.status} />
                  </div>
                  <p className="mt-1 text-xs text-stone-600 truncate">{lead.empresa}</p>
                  <p className="mt-0.5 font-mono text-[11px] text-stone-500 truncate">{lead.email}</p>
                </div>

                <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-5 gap-y-2 flex-1">
                  <div>
                    <dt className="text-[11px] text-stone-500">Tamanho da equipe</dt>
                    <dd className="mt-0.5 text-sm text-ink-950">{lead.tamanhoEquipe || '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] text-stone-500">Recebido em</dt>
                    <dd className="mt-0.5 text-sm text-ink-950 tabular">{new Date(lead.criadoEm).toLocaleString('pt-BR')}</dd>
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <dt className="text-[11px] text-stone-500">Origem</dt>
                    <dd className="mt-0.5 text-sm text-ink-950 truncate" title={lead.origem || ''}>{lead.origem || '—'}</dd>
                  </div>
                  {lead.observacao && (
                    <div className="col-span-2 sm:col-span-3">
                      <dt className="text-[11px] text-stone-500">Observação</dt>
                      <dd className="mt-0.5 text-sm text-stone-700">{lead.observacao}</dd>
                    </div>
                  )}
                </dl>

                <div className="flex flex-wrap gap-2 lg:justify-end lg:shrink-0">
                  <a href={`mailto:${lead.email}`} className="min-h-9 px-3 rounded-lg border border-paper-400 bg-white text-stone-700 hover:border-brand-300 hover:text-brand-800 text-xs font-semibold inline-flex items-center gap-1.5">
                    <Icon name="contact" size={15} />
                    Escrever
                  </a>
                  {lead.status !== 'contatado' && (
                    <button
                      onClick={() => atualizar.mutate({ id: lead.id, status: 'contatado' })}
                      disabled={atualizar.isPending}
                      className="min-h-9 px-3 rounded-lg text-emerald-800 bg-emerald-50 hover:bg-emerald-100 text-xs font-semibold disabled:opacity-40"
                    >
                      Marcar contatado
                    </button>
                  )}
                  {lead.status !== 'descartado' && (
                    <button
                      onClick={() => atualizar.mutate({ id: lead.id, status: 'descartado' })}
                      disabled={atualizar.isPending}
                      className="min-h-9 px-3 rounded-lg text-stone-600 bg-paper-200 hover:bg-paper-300 text-xs font-semibold disabled:opacity-40"
                    >
                      Descartar
                    </button>
                  )}
                  <button
                    onClick={() => setObservando(observando?.id === lead.id ? null : { id: lead.id, observacao: lead.observacao || '' })}
                    className="min-h-9 px-3 rounded-lg border border-paper-400 bg-white text-stone-700 hover:border-brand-300 hover:text-brand-800 text-xs font-semibold inline-flex items-center gap-1.5"
                  >
                    <Icon name="edit" size={15} />
                    Nota
                  </button>
                </div>
              </div>

              {observando?.id === lead.id && (
                <form
                  className="mt-3 flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    atualizar.mutate({ id: lead.id, status: lead.status, observacao: observando.observacao.trim() });
                  }}
                >
                  <textarea
                    autoFocus
                    className="input-field text-xs flex-1"
                    rows={2}
                    placeholder="Anotação sobre este lead"
                    value={observando.observacao}
                    onChange={(e) => setObservando({ id: lead.id, observacao: e.target.value })}
                  />
                  <div className="flex flex-col gap-2">
                    <button type="submit" disabled={atualizar.isPending} className="min-h-9 px-3 rounded-lg bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold disabled:opacity-40">Salvar</button>
                    <button type="button" onClick={() => setObservando(null)} className="min-h-9 px-3 rounded-lg border border-paper-400 text-stone-700 text-xs font-semibold">Cancelar</button>
                  </div>
                </form>
              )}
            </article>
          ))}
        </div>

        {!leads.isLoading && lista.length === 0 && (
          <div className="px-5 py-12 text-center">
            <span className="mx-auto w-11 h-11 rounded-xl bg-paper-200 text-stone-500 flex items-center justify-center">
              <Icon name="contact" size={21} />
            </span>
            <h3 className="mt-3 text-sm font-semibold text-ink-950">Nenhum lead {filtro ? `com status "${STATUS[filtro]?.label || filtro}"` : 'ainda'}</h3>
            <p className="mt-1 mx-auto max-w-md text-sm text-stone-600">
              Assim que alguém preencher o formulário da landing, ele aparece aqui.
            </p>
          </div>
        )}
      </section>
    </OperadorShell>
  );
}
