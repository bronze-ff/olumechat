import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../services/api';
import Spinner from '../../components/ui/Spinner';
import Icon from '../../components/ui/Icon';
import { useAuth } from '../../context/AuthContext';

const NOME_PROVEDOR = {
  anthropic: 'Anthropic (Claude)', openai: 'OpenAI', openrouter: 'OpenRouter',
  groq: 'Groq', ollama: 'Ollama (local)', vllm: 'vLLM (self-hosted)',
};

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

// Sem plano de IA: nada de formulário — só o convite pra contratar. Quem
// configura provider/modelo/chave é o time Falatta (painel do operador), não
// o admin do cliente — ver server/api/iaConfig.js e operador/tenants.js.
function SemPlano() {
  return (
    <Secao titulo="Agente de IA">
      <div className="flex items-start gap-3">
        <span className="w-9 h-9 rounded-lg bg-paper-200 text-stone-500 flex items-center justify-center shrink-0">
          <Icon name="bot" size={18} />
        </span>
        <div>
          <p className="text-sm font-medium text-stone-800">Não incluído no seu plano</p>
          <p className="mt-1 text-xs leading-relaxed text-stone-500 max-w-[54ch]">
            O agente de IA (primeiro atendimento, sugestão de resposta e outros recursos) é um recurso
            vendido à parte. Fale com o time Falatta para adicionar ao seu plano.
          </p>
        </div>
      </div>
    </Secao>
  );
}

export default function IaConfig() {
  const { user } = useAuth();
  const [sugestaoAtiva, setSugestaoAtiva] = useState(false);
  const [salvoRecursos, setSalvoRecursos] = useState(false);
  const qc = useQueryClient();

  const config = useQuery({
    queryKey: ['ia-config'],
    queryFn: () => api.get('/ia-config').then((r) => r.data),
    enabled: !!user?.iaHabilitada,
  });
  const geral = useQuery({
    queryKey: ['config'],
    queryFn: () => api.get('/config').then((r) => r.data),
    enabled: !!user?.iaHabilitada,
  });

  useEffect(() => {
    if (geral.data) setSugestaoAtiva(geral.data.ia_sugestao_ativa === 'S');
  }, [geral.data]);

  const salvarRecursos = useMutation({
    mutationFn: (ativo) => api.put('/config', { ia_sugestao_ativa: ativo ? 'S' : 'N' }),
    onSuccess: () => {
      setSalvoRecursos(true);
      qc.invalidateQueries({ queryKey: ['config'] });
      setTimeout(() => setSalvoRecursos(false), 2500);
    },
  });

  if (!user?.iaHabilitada) return <SemPlano />;
  if (config.isLoading) return <div className="p-10 flex justify-center"><Spinner /></div>;

  return (
    <div className="max-w-screen-md mx-auto space-y-4">
      <Secao titulo="Provedor de IA">
        <p className="text-xs text-stone-500">
          Provedor, modelo e chave de API são configurados pelo time Falatta — fale com o suporte para trocar.
        </p>
        {config.data?.ativo ? (
          <div className="rounded-lg border border-black/[0.07] px-3.5 py-3 flex items-center gap-3">
            <span className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0">
              <Icon name="bot" size={17} />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-stone-800">
                {NOME_PROVEDOR[config.data.provider] || config.data.provider} <span className="font-mono text-stone-400">· {config.data.modelo}</span>
              </p>
              {config.data.atualizadoEm && (
                <p className="text-[11px] text-stone-400">Atualizado em {new Date(config.data.atualizadoEm).toLocaleString('pt-BR')}</p>
              )}
            </div>
          </div>
        ) : (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            Seu plano inclui IA, mas o provedor ainda não foi configurado — fale com o time Falatta para ativar.
          </p>
        )}
      </Secao>

      <Secao titulo="Recursos para o atendente">
        <label className="flex items-start gap-3 cursor-pointer">
          <input type="checkbox" checked={sugestaoAtiva} disabled={!config.data?.ativo}
            onChange={(e) => { setSugestaoAtiva(e.target.checked); salvarRecursos.mutate(e.target.checked); }}
            className="w-4 h-4 mt-0.5 accent-brand-700 disabled:opacity-60" />
          <span>
            <span className="block text-sm font-medium text-stone-800">Sugestão de resposta</span>
            <span className="block text-xs text-stone-500 mt-0.5">
              No atendimento, o atendente pode pedir um rascunho de resposta baseado no histórico da conversa — ele revisa e edita antes de enviar; nada sai automaticamente.
            </span>
          </span>
        </label>
        {salvoRecursos && <span className="text-xs text-emerald-600 font-medium">✓ Salvo — vale na hora</span>}
      </Secao>

      {/* TODO(falatta): base de conhecimento editável por tenant entra aqui.
          A seção antiga puxava .sql de um repo GitHub do cliente original. */}
    </div>
  );
}
