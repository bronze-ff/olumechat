import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../services/api';
import Spinner from '../../components/ui/Spinner';
import { useAuth } from '../../context/AuthContext';

// Provedores aceitos pelo backend (api/iaConfig.js). anthropic usa a API nativa
// (sem baseUrl); os demais são OpenAI-compatíveis e exigem baseUrl.
const PROVEDORES = [
  { id: 'anthropic', rotulo: 'Anthropic (Claude)', modelo: 'Ex.: claude-opus-4-8', base: null },
  { id: 'openai', rotulo: 'OpenAI', modelo: 'Ex.: gpt-4o', base: 'https://api.openai.com/v1' },
  { id: 'openrouter', rotulo: 'OpenRouter', modelo: 'Ex.: anthropic/claude-3.5-sonnet', base: 'https://openrouter.ai/api/v1' },
  { id: 'groq', rotulo: 'Groq', modelo: 'Ex.: llama-3.1-70b-versatile', base: 'https://api.groq.com/openai/v1' },
  { id: 'ollama', rotulo: 'Ollama (local)', modelo: 'Ex.: llama3.1', base: 'http://localhost:11434/v1' },
  { id: 'vllm', rotulo: 'vLLM (self-hosted)', modelo: 'Ex.: meta-llama/Llama-3.1-70B', base: 'http://localhost:8000/v1' },
];

function Secao({ titulo, children }) {
  return (
    <section className="bg-white rounded-2xl border border-black/[0.06]">
      <header className="flex items-center gap-2 px-4 pt-3.5 pb-2.5 border-b border-black/[0.05]">
        <span className="section-bar" />
        <h2 className="font-display font-bold text-sm text-stone-800 flex-1">{titulo}</h2>
      </header>
      <div className="p-4 space-y-3">{children}</div>
    </section>
  );
}

export default function IaConfig() {
  const { isAdmin } = useAuth();
  const [provider, setProvider] = useState('anthropic');
  const [modelo, setModelo] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [salvo, setSalvo] = useState(false);
  const [erro, setErro] = useState('');
  const qc = useQueryClient();

  const config = useQuery({
    queryKey: ['ia-config'],
    queryFn: () => api.get('/ia-config').then((r) => r.data),
  });

  useEffect(() => {
    if (config.data && config.data.provider) {
      setProvider(config.data.provider);
      setModelo(config.data.modelo || '');
      setBaseUrl(config.data.baseUrl || '');
    }
  }, [config.data]);

  const prov = PROVEDORES.find((p) => p.id === provider) || PROVEDORES[0];
  const exigeBase = provider !== 'anthropic';
  const jaConfig = !!config.data?.ativo;                 // já há provedor salvo (com chave cifrada)
  const modeloEhUrl = /^https?:\/\//i.test(modelo.trim());
  // Na edição a chave é OPCIONAL (mantém a atual); na 1ª config é obrigatória.
  const podeSalvar = !!provider && modelo.trim() && !modeloEhUrl
    && (!exigeBase || baseUrl.trim()) && (jaConfig || apiKey.trim());

  const salvar = useMutation({
    mutationFn: () => api.put('/ia-config', {
      provider, modelo: modelo.trim(), baseUrl: exigeBase ? baseUrl.trim() : undefined,
      apiKey: apiKey.trim() || undefined, // vazio = mantém a chave atual
    }),
    onSuccess: () => {
      setErro(''); setSalvo(true); setApiKey('');
      qc.invalidateQueries({ queryKey: ['ia-config'] });
      setTimeout(() => setSalvo(false), 2500);
    },
    onError: (e) => setErro(e.response?.data?.error || 'Falha ao salvar.'),
  });

  if (config.isLoading) return <div className="p-10 flex justify-center"><Spinner /></div>;

  return (
    <div className="max-w-screen-md mx-auto space-y-4">
      <Secao titulo="Provedor de IA">
        <p className="text-xs text-stone-500">
          Define qual modelo responde no WhatsApp do bot. A chave é <b>cifrada</b> antes de gravar e
          <b> nunca é exibida</b>. Para trocar a chave, cole a nova; para mudar só o modelo/URL,
          <b> deixe o campo da chave em branco</b> (mantém a atual).
        </p>
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Provedor</label>
          <select className="input-field disabled:opacity-60" value={provider} disabled={!isAdmin}
            onChange={(e) => { setProvider(e.target.value); setErro(''); }}>
            {PROVEDORES.map((p) => <option key={p.id} value={p.id}>{p.rotulo}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Modelo</label>
          <input className="input-field font-mono disabled:opacity-60" value={modelo} disabled={!isAdmin}
            onChange={(e) => setModelo(e.target.value)} placeholder={prov.modelo} />
          {modeloEhUrl && (
            <p className="text-[11px] text-red-600 mt-1">Cole só o <b>ID</b> do modelo (ex.: {prov.modelo.replace('Ex.: ', '')}) — a URL vai no campo Base URL.</p>
          )}
        </div>
        {exigeBase && (
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Base URL</label>
            <input className="input-field font-mono disabled:opacity-60" value={baseUrl} disabled={!isAdmin}
              onChange={(e) => setBaseUrl(e.target.value)} placeholder={prov.base || 'https://…/v1'} />
          </div>
        )}
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">API key</label>
          <input type="password" autoComplete="new-password" className="input-field font-mono disabled:opacity-60"
            value={apiKey} disabled={!isAdmin} onChange={(e) => { setApiKey(e.target.value); setErro(''); }}
            placeholder={config.data?.ativo ? '•••••••• (guardada — deixe em branco para manter)' : 'Cole a chave do provedor'} />
        </div>
        <p className="text-[11px] text-stone-400">
          {config.data?.ativo
            ? `Ativo: ${config.data.provider} · ${config.data.modelo}${config.data.atualizadoEm ? ` · atualizado ${new Date(config.data.atualizadoEm).toLocaleString('pt-BR')}` : ''}`
            : 'Nenhum provedor configurado ainda — o bot não responde até configurar aqui.'}
        </p>
        {erro && <p className="text-xs text-red-600">{erro}</p>}
        {isAdmin ? (
          <div className="flex items-center gap-3">
            <button onClick={() => salvar.mutate()} disabled={!podeSalvar || salvar.isPending}
              className="px-6 py-2.5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-sm font-semibold disabled:opacity-40">
              {salvar.isPending ? 'Salvando…' : 'Salvar provedor'}
            </button>
            {salvo && <span className="text-xs text-emerald-600 font-medium">✓ Salvo — vale na hora</span>}
          </div>
        ) : (
          <p className="font-mono text-[10px] text-stone-400">somente ADMIN edita</p>
        )}
      </Secao>

      {/* TODO(falatta): base de conhecimento editável por tenant entra aqui.
          A seção antiga puxava .sql de um repo GitHub do cliente original. */}
    </div>
  );
}
