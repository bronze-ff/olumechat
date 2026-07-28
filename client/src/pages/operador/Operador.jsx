import { useMemo, useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiOperador, { CHAVE_TOKEN } from '../../services/apiOperador';
import Spinner from '../../components/ui/Spinner';
import Confirmar from '../../components/ui/Confirmar';
import Icon from '../../components/ui/Icon';
import OperadorShell from '../../components/layout/OperadorShell';
import FichaFinanceiraModal from './FichaFinanceiraModal';
import { SECOES, GRUPOS } from './nav';

const STATUS = {
  ativo: { label: 'Ativo', className: 'bg-emerald-50 text-emerald-800 border-emerald-200', dot: 'bg-emerald-500' },
  suspenso: { label: 'Suspenso', className: 'bg-amber-50 text-amber-800 border-amber-200', dot: 'bg-amber-500' },
  encerrado: { label: 'Encerrado', className: 'bg-stone-100 text-stone-700 border-stone-200', dot: 'bg-stone-400' },
};

function Status({ value }) {
  const status = STATUS[value] || STATUS.encerrado;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px] font-semibold ${status.className}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
      {status.label}
    </span>
  );
}

function Convite({ dados, onFechar }) {
  const [copiado, setCopiado] = useState(false);
  const copiar = async () => {
    await navigator.clipboard?.writeText(dados.convite.link);
    setCopiado(true);
  };

  return (
    <section className="app-panel border-emerald-200 overflow-hidden" aria-live="polite">
      <div className="px-5 py-4 flex flex-col lg:flex-row lg:items-start gap-4">
        <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0">
          <Icon name="check" size={20} strokeWidth={2.2} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-ink-950">Cliente criado. Envie o convite agora.</h2>
          <p className="mt-1 text-sm text-stone-600 max-w-[72ch]">
            O acesso de <strong>{dados.usuario.email}</strong> está pronto. Este link funciona uma única vez e expira em{' '}
            {new Date(dados.convite.expiraEm).toLocaleString('pt-BR')}.
          </p>
          <div className="mt-3 flex flex-col sm:flex-row gap-2">
            <code className="min-w-0 flex-1 px-3 py-2.5 rounded-lg bg-paper-100 border border-paper-300 text-xs text-stone-700 break-all">
              {dados.convite.link}
            </code>
            <button onClick={copiar} className="min-h-10 px-4 rounded-lg bg-ink-900 hover:bg-ink-950 text-white text-sm font-semibold inline-flex items-center justify-center gap-2">
              <Icon name={copiado ? 'check' : 'copy'} size={16} />
              {copiado ? 'Link copiado' : 'Copiar convite'}
            </button>
          </div>
          <p className="mt-2 text-xs text-stone-500">
            Próximo passo: peça ao administrador para definir a senha e conectar a conta da Meta no painel da empresa.
          </p>
        </div>
        <button onClick={onFechar} className="text-xs font-semibold text-stone-500 hover:text-ink-950">Fechar</button>
      </div>
    </section>
  );
}

function Summary({ totais, mensagens }) {
  const items = [
    { label: 'Clientes cadastrados', value: totais.clientes, detail: 'total da carteira' },
    { label: 'Clientes ativos', value: totais.ativos, detail: `${totais.suspensos} suspensos` },
    { label: 'Conversas no mês', value: totais.conversas, detail: 'em todos os clientes' },
    { label: 'Mensagens enviadas', value: mensagens, detail: 'no mês atual' },
  ];
  return (
    <section className="app-panel overflow-hidden">
      <div className="grid grid-cols-2 xl:grid-cols-4 divide-x divide-y xl:divide-y-0 divide-paper-300">
        {items.map((item) => (
          <div key={item.label} className="px-4 py-4 md:px-5">
            <p className="text-xs font-medium text-stone-600">{item.label}</p>
            <div className="mt-2 flex items-baseline gap-2">
              <strong className="text-2xl font-semibold tracking-[-0.03em] text-ink-950 tabular">{item.value}</strong>
              <span className="text-[11px] text-stone-500">{item.detail}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Provisionamento({ form, setForm, podeProvisionar, provisionar }) {
  return (
    <section className="app-panel overflow-hidden">
      <header className="px-5 py-4 border-b border-paper-300">
        <div className="flex items-start gap-3">
          <span className="w-8 h-8 rounded-lg bg-brand-100 text-brand-800 flex items-center justify-center text-sm font-semibold">1</span>
          <div>
            <h2 className="font-semibold text-ink-950">Cadastrar um novo cliente</h2>
            <p className="mt-0.5 text-xs text-stone-600">Cria a empresa, o primeiro administrador e o convite de acesso em uma única operação.</p>
          </div>
        </div>
      </header>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (podeProvisionar) provisionar.mutate();
        }}
        className="p-5 space-y-5"
      >
        <div>
          <label htmlFor="empresa-nome" className="field-label">Nome da empresa</label>
          <input
            id="empresa-nome"
            className="input-field"
            value={form.nome}
            placeholder="Ex.: Clínica Horizonte"
            onChange={(event) => setForm((prev) => ({ ...prev, nome: event.target.value }))}
          />
          <p className="mt-1.5 text-xs text-stone-500">Este é o nome que aparecerá no painel e nos relatórios.</p>
        </div>

        <div>
          <label htmlFor="empresa-slug" className="field-label">Identificador de acesso</label>
          <div className="flex rounded-lg focus-within:ring-2 focus-within:ring-brand-200">
            <span className="min-h-11 px-3 flex items-center rounded-l-lg border border-r-0 border-paper-400 bg-paper-100 text-xs text-stone-500">
              falatta.com/
            </span>
            <input
              id="empresa-slug"
              className="input-field !rounded-l-none font-mono"
              value={form.slug}
              placeholder="clinica-horizonte"
              autoCapitalize="none"
              spellCheck="false"
              onChange={(event) => setForm((prev) => ({ ...prev, slug: event.target.value }))}
            />
          </div>
          <p className="mt-1.5 text-xs text-stone-500">Use letras minúsculas, números e hífen. Esse identificador não muda depois.</p>
        </div>

        <div className="pt-1 border-t border-paper-300">
          <p className="mt-4 text-sm font-semibold text-ink-950">Administrador inicial</p>
          <p className="mt-0.5 mb-3 text-xs text-stone-500">Essa pessoa receberá o convite e configurará a empresa.</p>
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="admin-nome" className="field-label">Nome <span className="font-normal text-stone-500">(opcional)</span></label>
              <input
                id="admin-nome"
                className="input-field"
                value={form.adminNome}
                placeholder="Ana Martins"
                onChange={(event) => setForm((prev) => ({ ...prev, adminNome: event.target.value }))}
              />
            </div>
            <div>
              <label htmlFor="admin-email" className="field-label">E-mail de acesso</label>
              <input
                id="admin-email"
                type="email"
                className="input-field"
                value={form.adminEmail}
                placeholder="ana@empresa.com.br"
                autoCapitalize="none"
                spellCheck="false"
                onChange={(event) => setForm((prev) => ({ ...prev, adminEmail: event.target.value }))}
              />
            </div>
          </div>
        </div>

        <div className="pt-1 flex flex-col sm:flex-row sm:items-center gap-3">
          <button
            type="submit"
            disabled={!podeProvisionar || provisionar.isPending}
            className="min-h-11 px-5 rounded-lg bg-brand-700 hover:bg-brand-800 text-white text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
          >
            {provisionar.isPending ? <Spinner size="sm" /> : <Icon name="plus" size={17} />}
            {provisionar.isPending ? 'Criando cliente…' : 'Criar cliente e convite'}
          </button>
          <p className="text-xs text-stone-500">Se alguma etapa falhar, nada é criado.</p>
        </div>
      </form>
    </section>
  );
}

const IA_PROVEDORES = [
  { id: 'anthropic', rotulo: 'Anthropic (Claude)', modelo: 'Ex.: claude-opus-4-8', base: null },
  { id: 'openai', rotulo: 'OpenAI', modelo: 'Ex.: gpt-4o', base: 'https://api.openai.com/v1' },
  { id: 'openrouter', rotulo: 'OpenRouter', modelo: 'Ex.: anthropic/claude-3.5-sonnet', base: 'https://openrouter.ai/api/v1' },
  { id: 'groq', rotulo: 'Groq', modelo: 'Ex.: llama-3.1-70b-versatile', base: 'https://api.groq.com/openai/v1' },
  { id: 'ollama', rotulo: 'Ollama (local)', modelo: 'Ex.: llama3.1', base: 'http://localhost:11434/v1' },
  { id: 'vllm', rotulo: 'vLLM (self-hosted)', modelo: 'Ex.: meta-llama/Llama-3.1-70B', base: 'http://localhost:8000/v1' },
];

// IA é add-on vendido à parte (ver server/operador/tenants.js::salvarIaConfig):
// só o operador liga o plano e configura provider/modelo/chave por cliente —
// o admin do tenant (IaConfig.jsx) só enxerga o status, nunca edita isto.
function IaModal({ tenant, onClose }) {
  const qc = useQueryClient();
  const [provider, setProvider] = useState('anthropic');
  const [modelo, setModelo] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [erro, setErro] = useState('');
  const [salvo, setSalvo] = useState(false);

  const cfg = useQuery({
    queryKey: ['operador', 'ia-config', tenant.id],
    queryFn: () => apiOperador.get(`/tenants/${tenant.id}/ia-config`).then((r) => r.data),
  });
  useEffect(() => {
    if (cfg.data?.provider) {
      setProvider(cfg.data.provider);
      setModelo(cfg.data.modelo || '');
      setBaseUrl(cfg.data.baseUrl || '');
    }
  }, [cfg.data]);

  // `tenant` é um snapshot tirado no clique que abriu o modal — invalidar a
  // lista refaz o fetch em segundo plano, mas não atualiza essa prop (o modal
  // continua de pé com o objeto antigo). Estado local, atualizado a partir do
  // valor que a MUTATION confirmou, é o que mantém o toggle em sincronia.
  const [habilitadaLocal, setHabilitadaLocal] = useState(tenant.iaHabilitada === 'S');
  const alternarHabilitada = useMutation({
    mutationFn: (valor) => apiOperador.post(`/tenants/${tenant.id}/ia`, { habilitada: valor }),
    onSuccess: (_dados, valor) => {
      setHabilitadaLocal(valor);
      qc.invalidateQueries({ queryKey: ['operador', 'tenants'] });
    },
  });

  const prov = IA_PROVEDORES.find((p) => p.id === provider) || IA_PROVEDORES[0];
  const exigeBase = provider !== 'anthropic';
  const modeloEhUrl = /^https?:\/\//i.test(modelo.trim());
  const podeSalvar = provider && modelo.trim() && !modeloEhUrl && (!exigeBase || baseUrl.trim()) && (cfg.data?.ativo || apiKey.trim());

  const salvar = useMutation({
    mutationFn: () => apiOperador.put(`/tenants/${tenant.id}/ia-config`, {
      provider, modelo: modelo.trim(), baseUrl: exigeBase ? baseUrl.trim() : undefined, apiKey: apiKey.trim() || undefined,
    }),
    onSuccess: () => {
      setErro(''); setSalvo(true); setApiKey('');
      qc.invalidateQueries({ queryKey: ['operador', 'ia-config', tenant.id] });
      setTimeout(() => setSalvo(false), 2500);
    },
    onError: (e) => setErro(e.response?.data?.error || 'Falha ao salvar.'),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-ink-950/60 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative w-full sm:max-w-md bg-white border border-paper-400 rounded-t-[10px] sm:rounded-[10px] shadow-2xl overflow-hidden max-h-[92vh] flex flex-col">
        <div className="px-5 py-4 border-b border-paper-300 flex items-center gap-3">
          <span className="w-9 h-9 rounded-lg bg-brand-100 text-brand-800 flex items-center justify-center shrink-0">
            <Icon name="bot" size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold text-ink-950 truncate">Configuração de IA</h2>
            <p className="text-xs text-stone-500 truncate">{tenant.nome}</p>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-lg border border-paper-400 text-stone-500 hover:bg-paper-100 hover:text-ink-950" aria-label="Fechar">✕</button>
        </div>
        <div className="modal-body space-y-4">
          <label className="flex items-center justify-between gap-3 p-3 rounded-lg border border-paper-400 bg-paper-50 cursor-pointer">
            <span>
              <span className="block text-sm font-medium text-ink-950">IA incluída no plano</span>
              <span className="block text-xs text-stone-500 mt-0.5">Liga/desliga o add-on de IA para este cliente.</span>
            </span>
            <input type="checkbox" checked={habilitadaLocal} disabled={alternarHabilitada.isPending}
              onChange={(e) => alternarHabilitada.mutate(e.target.checked)}
              className="w-5 h-5 accent-brand-700 shrink-0" />
          </label>

          {cfg.isLoading ? <div className="p-6 flex justify-center"><Spinner /></div> : (
            <>
              <div>
                <label className="field-label">Provedor</label>
                <select className="input-field" value={provider} onChange={(e) => { setProvider(e.target.value); setErro(''); }}>
                  {IA_PROVEDORES.map((p) => <option key={p.id} value={p.id}>{p.rotulo}</option>)}
                </select>
              </div>
              <div>
                <label className="field-label">Modelo</label>
                <input className="input-field font-mono" value={modelo} onChange={(e) => setModelo(e.target.value)} placeholder={prov.modelo} />
                {modeloEhUrl && <p className="text-[11px] text-red-600 mt-1">Cole só o ID do modelo — a URL vai em Base URL.</p>}
              </div>
              {exigeBase && (
                <div>
                  <label className="field-label">Base URL</label>
                  <input className="input-field font-mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={prov.base || 'https://…/v1'} />
                </div>
              )}
              <div>
                <label className="field-label">API key</label>
                <input type="password" autoComplete="new-password" className="input-field font-mono" value={apiKey}
                  onChange={(e) => { setApiKey(e.target.value); setErro(''); }}
                  placeholder={cfg.data?.ativo ? '•••••••• (guardada — deixe em branco para manter)' : 'Cole a chave do provedor'} />
              </div>
              <p className="text-[11px] text-stone-500">
                {cfg.data?.ativo ? `Ativo: ${cfg.data.provider} · ${cfg.data.modelo}` : 'Nenhum provedor configurado ainda — a IA não roda até salvar aqui.'}
              </p>
              {erro && <p className="text-xs text-red-600">{erro}</p>}
            </>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="flex-1 min-h-10 rounded-lg border border-paper-400 bg-white hover:bg-paper-100 text-stone-700 font-semibold text-sm">Fechar</button>
          <button onClick={() => salvar.mutate()} disabled={!podeSalvar || salvar.isPending || cfg.isLoading}
            className="flex-1 min-h-10 rounded-lg bg-brand-700 hover:bg-brand-800 text-white font-semibold text-sm disabled:opacity-40">
            {salvar.isPending ? 'Salvando…' : salvo ? '✓ Salvo' : 'Salvar provedor'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ClientList({ lista, tenants, renomeando, setRenomeando, renomear, setConfirmacao, suporte, alterarStatus, setIaModal, setFichaFinanceira }) {
  return (
    <section className="app-panel overflow-hidden">
      <header className="px-5 py-4 flex flex-wrap items-center gap-3 border-b border-paper-300">
        <div className="flex-1">
          <h2 className="font-semibold text-ink-950">Clientes</h2>
          <p className="mt-0.5 text-xs text-stone-500">Acompanhe adoção, acesse o suporte e controle o status de cada empresa.</p>
        </div>
        <span className="text-xs font-medium text-stone-500">{lista.length} {lista.length === 1 ? 'empresa' : 'empresas'}</span>
      </header>

      {tenants.isLoading && <div className="p-12 flex justify-center"><Spinner /></div>}
      {tenants.isError && <p className="p-5 text-sm text-red-700">Não foi possível carregar os clientes.</p>}

      <div className="divide-y divide-paper-300">
        {lista.map((tenant) => (
          <article key={tenant.id} className="px-5 py-4 hover:bg-paper-50">
            <div className="flex flex-col xl:flex-row xl:items-center gap-4">
              <div className="min-w-0 xl:w-56 shrink-0">
                {renomeando?.id === tenant.id ? (
                  <form
                    className="flex gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const nome = renomeando.nome.trim();
                      if (nome && nome !== tenant.nome) renomear.mutate({ id: tenant.id, nome });
                      else setRenomeando(null);
                    }}
                  >
                    <input
                      autoFocus
                      className="input-field !min-h-9 !py-1.5"
                      value={renomeando.nome}
                      onChange={(event) => setRenomeando({ id: tenant.id, nome: event.target.value })}
                    />
                    <button type="submit" disabled={renomear.isPending} className="px-3 rounded-lg bg-brand-700 text-white text-xs font-semibold">Salvar</button>
                    <button type="button" onClick={() => setRenomeando(null)} className="px-3 rounded-lg border border-paper-400 text-stone-700 text-xs font-semibold">Cancelar</button>
                  </form>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <p className="font-semibold text-sm text-ink-950 truncate">{tenant.nome}</p>
                      <Status value={tenant.status} />
                      {tenant.iaHabilitada === 'S' && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-brand-200 bg-brand-50 text-brand-700 text-[10px] font-semibold shrink-0" title="IA incluída no plano">
                          <Icon name="bot" size={11} /> IA
                        </span>
                      )}
                    </div>
                    <p className="mt-1 font-mono text-[11px] text-stone-500">{tenant.slug}</p>
                  </>
                )}
              </div>

              <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-5 gap-y-2 flex-1">
                {[
                  ['Conversas/mês', tenant.conversasMes],
                  ['Mensagens/mês', tenant.mensagensMes],
                  ['Atendentes', tenant.atendentesAtivos],
                  ['Canais', tenant.numerosConectados],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-[11px] text-stone-500">{label}</dt>
                    <dd className="mt-0.5 text-sm font-semibold text-ink-950 tabular">{value ?? 0}</dd>
                  </div>
                ))}
              </dl>

              <div className="flex flex-wrap gap-2 xl:justify-end">
                <button
                  onClick={() => setConfirmacao({
                    titulo: 'Iniciar implantação',
                    mensagem: `Você entrará em "${tenant.nome}" com administração completa para configurar equipe, departamentos, canais, fluxos e regras da operação.`,
                    dica: 'A sessão é temporária, limitada a esta empresa e cada alteração fica registrada na auditoria.',
                    confirmarTexto: 'Administrar cliente',
                    acao: () => suporte.mutate({ id: tenant.id }),
                  })}
                  className="min-h-9 px-3 rounded-lg border border-paper-400 bg-white text-stone-700 hover:border-brand-300 hover:text-brand-800 text-xs font-semibold inline-flex items-center gap-1.5"
                >
                  <Icon name="support" size={15} />
                  Implantar
                </button>
                <button
                  onClick={() => setRenomeando({ id: tenant.id, nome: tenant.nome })}
                  className="min-h-9 px-3 rounded-lg border border-paper-400 bg-white text-stone-700 hover:border-brand-300 hover:text-brand-800 text-xs font-semibold inline-flex items-center gap-1.5"
                >
                  <Icon name="edit" size={15} />
                  Renomear
                </button>
                <button
                  onClick={() => setIaModal(tenant)}
                  className="min-h-9 px-3 rounded-lg border border-paper-400 bg-white text-stone-700 hover:border-brand-300 hover:text-brand-800 text-xs font-semibold inline-flex items-center gap-1.5"
                >
                  <Icon name="bot" size={15} />
                  IA
                </button>
                <button
                  onClick={() => setFichaFinanceira(tenant)}
                  className="min-h-9 px-3 rounded-lg border border-paper-400 bg-white text-stone-700 hover:border-brand-300 hover:text-brand-800 text-xs font-semibold inline-flex items-center gap-1.5"
                >
                  <Icon name="chart" size={15} />
                  Financeiro
                </button>
                {tenant.status === 'ativo' ? (
                  <button
                    onClick={() => setConfirmacao({
                      titulo: 'Suspender cliente',
                      mensagem: `Suspender "${tenant.nome}"?`,
                      dica: 'Isso bloqueia o login dos usuários e pausa os disparos de campanha.',
                      confirmarTexto: 'Suspender cliente',
                      perigo: true,
                      acao: () => alterarStatus.mutate({ id: tenant.id, acao: 'suspender' }),
                    })}
                    className="min-h-9 px-3 rounded-lg text-amber-800 bg-amber-50 hover:bg-amber-100 text-xs font-semibold"
                  >
                    Suspender
                  </button>
                ) : (
                  <button
                    onClick={() => alterarStatus.mutate({ id: tenant.id, acao: 'reativar' })}
                    className="min-h-9 px-3 rounded-lg text-emerald-800 bg-emerald-50 hover:bg-emerald-100 text-xs font-semibold"
                  >
                    Reativar
                  </button>
                )}
              </div>
            </div>
          </article>
        ))}
      </div>

      {tenants.data?.length === 0 && (
        <div className="px-5 py-12 text-center">
          <span className="mx-auto w-11 h-11 rounded-xl bg-paper-200 text-stone-500 flex items-center justify-center">
            <Icon name="building" size={21} />
          </span>
          <h3 className="mt-3 text-sm font-semibold text-ink-950">Sua carteira ainda está vazia</h3>
          <p className="mt-1 mx-auto max-w-md text-sm text-stone-600">
            Cadastre a primeira empresa no formulário abaixo. Ao concluir, você receberá o convite do administrador para envio.
          </p>
          <Link to="/operador/novo-cliente" className="mt-4 inline-flex min-h-10 items-center gap-2 px-4 rounded-lg bg-brand-700 text-white text-sm font-semibold">
            <Icon name="plus" size={16} />
            Cadastrar primeiro cliente
          </Link>
        </div>
      )}
    </section>
  );
}

const STATUS_ETAPA = {
  pendente: { label: 'Pendente', className: 'bg-stone-100 text-stone-700 border-stone-200', dot: 'bg-stone-400' },
  em_andamento: { label: 'Em andamento', className: 'bg-blue-50 text-blue-800 border-blue-200', dot: 'bg-blue-500' },
  bloqueada: { label: 'Bloqueada', className: 'bg-red-50 text-red-800 border-red-200', dot: 'bg-red-500' },
};

// "Quem está travado em qual etapa" (FIL-81): cross-tenant de propósito — é a
// visão de carteira, não o acompanhamento de UM cliente (esse é feito dentro
// da sessão de suporte, na aba "Onboarding Meta" do painel do cliente).
function Onboarding({ progresso }) {
  const lista = progresso.data || [];
  return (
    <section className="app-panel overflow-hidden">
      <header className="px-5 py-4 border-b border-paper-300">
        <h2 className="font-semibold text-ink-950">Onboarding assistido da Meta</h2>
        <p className="mt-0.5 text-xs text-stone-500">Progresso por cliente — quem está parado e em qual etapa.</p>
      </header>
      {progresso.isLoading && <div className="p-12 flex justify-center"><Spinner /></div>}
      {progresso.isError && <p className="p-5 text-sm text-red-700">Não foi possível carregar o onboarding.</p>}
      <div className="divide-y divide-paper-300">
        {lista.map((item) => (
          <article key={item.tenantId} className="px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="min-w-0 sm:w-56 shrink-0">
              <p className="font-semibold text-sm text-ink-950 truncate">{item.tenantNome}</p>
              <p className="mt-0.5 font-mono text-[11px] text-stone-500">{item.tenantSlug}</p>
            </div>
            <div className="flex-1 min-w-0">
              {item.concluido ? (
                <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px] font-semibold bg-emerald-50 text-emerald-800 border-emerald-200">
                  <Icon name="check" size={12} /> Onboarding concluído
                </span>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  {item.travado && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-red-50 text-red-700 text-[10px] font-semibold" title="Precisa de atenção">
                      <Icon name="alert" size={11} /> Travado
                    </span>
                  )}
                  <span className="text-sm text-ink-950">{item.etapaAtual?.titulo}</span>
                  {item.etapaAtual && (
                    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] font-semibold ${(STATUS_ETAPA[item.etapaAtual.status] || STATUS_ETAPA.pendente).className}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${(STATUS_ETAPA[item.etapaAtual.status] || STATUS_ETAPA.pendente).dot}`} />
                      {(STATUS_ETAPA[item.etapaAtual.status] || STATUS_ETAPA.pendente).label}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="text-xs text-stone-500 tabular shrink-0">{item.etapasConcluidas}/{item.etapasTotal} etapas</div>
          </article>
        ))}
      </div>
      {!progresso.isLoading && lista.length === 0 && (
        <p className="p-8 text-sm text-stone-600 text-center">Nenhum cliente na carteira ainda.</p>
      )}
    </section>
  );
}

function Audit({ auditoria, filtro, setFiltro, lista }) {
  return (
    <section className="app-panel overflow-hidden">
      <header className="px-5 py-4 flex flex-wrap items-center gap-3 border-b border-paper-300">
        <div className="flex-1">
          <h2 className="font-semibold text-ink-950">Atividade administrativa</h2>
          <p className="mt-0.5 text-xs text-stone-500">Trilha das ações realizadas pelos operadores da Falatta.</p>
        </div>
        <select className="min-h-10 text-xs border border-paper-400 rounded-lg px-3 bg-white text-stone-700" value={filtro} onChange={(event) => setFiltro(event.target.value)}>
          <option value="">Todos os clientes</option>
          {lista.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.nome}</option>)}
        </select>
      </header>
      {auditoria.isLoading && <div className="p-8 flex justify-center"><Spinner /></div>}
      <div className="overflow-x-auto max-h-96">
        <table className="w-full min-w-[720px] text-xs">
          <thead className="sticky top-0 bg-paper-100 text-stone-600">
            <tr>
              <th className="px-5 py-2.5 text-left font-semibold">Data e hora</th>
              <th className="px-5 py-2.5 text-left font-semibold">Ação</th>
              <th className="px-5 py-2.5 text-left font-semibold">Operador</th>
              <th className="px-5 py-2.5 text-left font-semibold">Cliente</th>
              <th className="px-5 py-2.5 text-left font-semibold">IP</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-paper-300">
            {(auditoria.data || []).map((item) => (
              <tr key={item.id} className="hover:bg-paper-50">
                <td className="px-5 py-3 font-mono text-stone-500 tabular">{new Date(item.criadoEm).toLocaleString('pt-BR')}</td>
                <td className="px-5 py-3 font-semibold text-ink-950">{item.acao}</td>
                <td className="px-5 py-3 text-stone-600">{item.operadorEmail}</td>
                <td className="px-5 py-3 font-mono text-brand-800">{item.tenantSlug || '—'}</td>
                <td className="px-5 py-3 font-mono text-stone-500">{item.ip || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {auditoria.data?.length === 0 && <p className="p-8 text-sm text-stone-600 text-center">Nenhuma ação corresponde a este filtro.</p>}
      </div>
    </section>
  );
}

export default function Operador({ secao = 'clientes' }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState({ nome: '', slug: '', adminNome: '', adminEmail: '' });
  const [erro, setErro] = useState('');
  const [convite, setConvite] = useState(null);
  const [confirmacao, setConfirmacao] = useState(null);
  const [renomeando, setRenomeando] = useState(null);
  const [filtroAuditoria, setFiltroAuditoria] = useState('');
  const [iaModal, setIaModal] = useState(null);
  const [fichaFinanceira, setFichaFinanceira] = useState(null);

  const eu = useQuery({ queryKey: ['operador', 'eu'], queryFn: () => apiOperador.get('/eu').then((response) => response.data) });
  const tenants = useQuery({ queryKey: ['operador', 'tenants'], queryFn: () => apiOperador.get('/tenants').then((response) => response.data) });
  const auditoria = useQuery({
    queryKey: ['operador', 'auditoria', filtroAuditoria],
    queryFn: () => apiOperador.get('/auditoria', { params: filtroAuditoria ? { tenantId: filtroAuditoria } : {} }).then((response) => response.data),
    enabled: secao === 'auditoria',
  });
  const onboarding = useQuery({
    queryKey: ['operador', 'onboarding'],
    queryFn: () => apiOperador.get('/onboarding').then((response) => response.data),
    enabled: secao === 'onboarding',
  });

  const recarregar = () => {
    qc.invalidateQueries({ queryKey: ['operador', 'tenants'] });
    qc.invalidateQueries({ queryKey: ['operador', 'auditoria'] });
  };

  const provisionar = useMutation({
    mutationFn: () => apiOperador.post('/tenants', {
      nome: form.nome.trim(),
      slug: form.slug.trim().toLowerCase(),
      admin: { nome: form.adminNome.trim() || undefined, email: form.adminEmail.trim().toLowerCase() },
    }).then((response) => response.data),
    onSuccess: (data) => {
      setErro('');
      setConvite(data);
      setForm({ nome: '', slug: '', adminNome: '', adminEmail: '' });
      recarregar();
    },
    onError: (error) => setErro(error.response?.data?.error || 'Não foi possível criar o cliente. Revise os dados e tente novamente.'),
  });

  const alterarStatus = useMutation({
    mutationFn: ({ id, acao }) => apiOperador.post(`/tenants/${id}/${acao}`),
    onSuccess: () => { setConfirmacao(null); recarregar(); },
    onError: (error) => { setConfirmacao(null); setErro(error.response?.data?.error || 'Não foi possível alterar o status do cliente.'); },
  });

  const renomear = useMutation({
    mutationFn: ({ id, nome }) => apiOperador.patch(`/tenants/${id}`, { nome }),
    onSuccess: () => { setRenomeando(null); recarregar(); },
    onError: (error) => { setRenomeando(null); setErro(error.response?.data?.error || 'Não foi possível renomear o cliente.'); },
  });

  const suporte = useMutation({
    mutationFn: ({ id }) => apiOperador.post(`/tenants/${id}/acesso-suporte`).then((response) => response.data),
    onSuccess: (data) => {
      localStorage.setItem('token', data.token);
      localStorage.setItem('empresa', data.tenant.slug);
      setConfirmacao(null);
      window.location.assign('/conversas');
    },
    onError: (error) => { setConfirmacao(null); setErro(error.response?.data?.error || 'Não foi possível abrir o acesso de suporte.'); },
  });

  async function sair() {
    try { await apiOperador.post('/logout'); } catch { /* encerra a sessão local mesmo sem resposta */ }
    localStorage.removeItem(CHAVE_TOKEN);
    navigate('/operador/login', { replace: true });
  }

  const podeProvisionar = form.nome.trim() && form.slug.trim() && form.adminEmail.trim();
  const lista = tenants.data || [];
  const totais = useMemo(() => ({
    clientes: lista.length,
    ativos: lista.filter((tenant) => tenant.status === 'ativo').length,
    suspensos: lista.filter((tenant) => tenant.status === 'suspenso').length,
    conversas: lista.reduce((sum, tenant) => sum + (tenant.conversasMes || 0), 0),
  }), [lista]);
  const mensagens = useMemo(() => lista.reduce((sum, tenant) => sum + (tenant.mensagensMes || 0), 0), [lista]);
  const atual = SECOES.find((item) => item.id === secao) || SECOES[0];

  const titulo = {
    clientes: 'Carteira de clientes',
    'novo-cliente': 'Cadastrar novo cliente',
    onboarding: 'Onboarding assistido da Meta',
    auditoria: 'Auditoria',
  }[secao];
  const descricao = {
    clientes: 'Acompanhe a carteira, o uso e os acessos de suporte de cada empresa.',
    'novo-cliente': 'Crie a empresa e entregue ao administrador um acesso pronto para configuração.',
    onboarding: 'Progresso do processo assistido de conexão com a Meta, por cliente.',
    auditoria: 'Consulte a trilha das ações realizadas pela equipe de operações.',
  }[secao];
  const acao = secao === 'clientes' ? (
    <Link to="/operador/novo-cliente" className="min-h-10 px-4 rounded-lg bg-brand-700 hover:bg-brand-800 text-white text-sm font-semibold inline-flex items-center gap-2">
      <Icon name="plus" size={17} />
      Novo cliente
    </Link>
  ) : (
    <Link to="/operador/clientes" className="min-h-10 px-4 rounded-lg border border-paper-400 bg-white hover:bg-paper-100 text-stone-700 text-sm font-semibold inline-flex items-center gap-2">
      <Icon name="arrow" size={15} className="rotate-180" />
      Voltar aos clientes
    </Link>
  );

  return (
    <OperadorShell
      secoes={SECOES}
      grupos={GRUPOS}
      atual={atual}
      eu={eu}
      onSair={sair}
      titulo={titulo}
      descricao={descricao}
      acao={acao}
      erro={erro}
      onFecharErro={() => setErro('')}
    >
      {secao === 'clientes' && (
        <div className="space-y-5">
          <Summary totais={totais} mensagens={mensagens} />
          <ClientList
            lista={lista}
            tenants={tenants}
            renomeando={renomeando}
            setRenomeando={setRenomeando}
            renomear={renomear}
            setConfirmacao={setConfirmacao}
            suporte={suporte}
            alterarStatus={alterarStatus}
            setIaModal={setIaModal}
            setFichaFinanceira={setFichaFinanceira}
          />
        </div>
      )}

      {secao === 'novo-cliente' && (
        <div className="space-y-5">
          {convite && <Convite dados={convite} onFechar={() => setConvite(null)} />}
          <div className="grid xl:grid-cols-[minmax(0,1fr)_320px] gap-5 items-start">
            <Provisionamento form={form} setForm={setForm} podeProvisionar={podeProvisionar} provisionar={provisionar} />
            <aside className="app-panel p-5 xl:sticky xl:top-20">
              <h2 className="font-semibold text-ink-950">Como ativar uma empresa</h2>
              <ol className="mt-4 space-y-4">
                {[
                  ['Cadastre a empresa', 'Informe o identificador e o primeiro administrador.'],
                  ['Envie o convite', 'Copie o link único e encaminhe por um canal seguro.'],
                  ['Conecte o WhatsApp', 'O administrador entra no painel e conclui a conexão com a Meta.'],
                  ['Valide a operação', 'Confirme canais, atendentes e primeiro atendimento antes da entrega.'],
                ].map(([title, text], index) => (
                  <li key={title} className="flex gap-3">
                    <span className="w-7 h-7 rounded-lg bg-paper-200 text-stone-700 flex items-center justify-center text-xs font-semibold shrink-0">{index + 1}</span>
                    <div>
                      <p className="text-xs font-semibold text-ink-950">{title}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-stone-600">{text}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <div className="mt-5 pt-4 border-t border-paper-300">
                <p className="text-xs text-stone-600">
                  O modo de implantação permite administrar toda a configuração do cliente sem criar o operador como atendente. A sessão é temporária e auditada.
                </p>
              </div>
            </aside>
          </div>
        </div>
      )}

      {secao === 'onboarding' && <Onboarding progresso={onboarding} />}

      {secao === 'auditoria' && (
        <Audit auditoria={auditoria} filtro={filtroAuditoria} setFiltro={setFiltroAuditoria} lista={lista} />
      )}

      {iaModal && <IaModal tenant={iaModal} onClose={() => setIaModal(null)} />}
      {fichaFinanceira && <FichaFinanceiraModal tenant={fichaFinanceira} onClose={() => setFichaFinanceira(null)} />}

      {confirmacao && (
        <Confirmar
          titulo={confirmacao.titulo}
          mensagem={confirmacao.mensagem}
          dica={confirmacao.dica}
          confirmarTexto={confirmacao.confirmarTexto}
          perigo={confirmacao.perigo}
          pendente={alterarStatus.isPending || suporte.isPending}
          onConfirmar={confirmacao.acao}
          onCancelar={() => setConfirmacao(null)}
        />
      )}
    </OperadorShell>
  );
}
