import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../services/api';
import Spinner from '../../components/ui/Spinner';
import Icon from '../../components/ui/Icon';
import { useAuth } from '../../context/AuthContext';

const NOME_PROVEDOR = {
  anthropic: 'Anthropic (Claude)', openai: 'OpenAI', openrouter: 'OpenRouter',
  groq: 'Groq', ollama: 'Ollama (local)', vllm: 'vLLM (self-hosted)',
};

// FIL-83: uma tela só, na ordem em que se configura pela primeira vez —
// instruções → ficha → base → medidor → teste. Configurar isso é tarefa única,
// feita uma vez por quem acabou de contratar; espalhar em abas separadas
// pioraria exatamente o primeiro uso.
const CAMPOS_FICHA = [
  { chave: 'endereco', rotulo: 'Endereço', placeholder: 'Rua das Flores, 100 — Setor Central, Goiânia/GO' },
  { chave: 'telefones', rotulo: 'Telefones', placeholder: '(62) 3333-0000 · WhatsApp (62) 99999-0000' },
  { chave: 'horario', rotulo: 'Horário de atendimento', placeholder: 'Seg a sex 8h às 18h · Sáb 8h às 12h' },
  { chave: 'pagamento', rotulo: 'Formas de pagamento', placeholder: 'Pix, cartão em até 3x, dinheiro' },
  { chave: 'site', rotulo: 'Site', placeholder: 'www.suaempresa.com.br' },
  { chave: 'observacoes', rotulo: 'Observações', placeholder: 'Estacionamento gratuito no local. Não trabalhamos com entrega aos domingos.' },
];

// Espelho dos limites do servidor (server/ia/perfilStore.js::LIMITES). O GET
// devolve os valores reais em `limites`; estes só cobrem o intervalo entre a
// falha do GET e o retry — sem eles, os contadores fariam toLocaleString() em
// undefined e derrubariam a página inteira.
const LIMITES_PADRAO = { instrucoes: 8000, blocoTitulo: 120, blocoConteudo: 20000, blocos: 50 };
const MEDIDOR_VAZIO = { caracteres: 0, tokensEstimados: 0, faixa: 'verde' };

// A chamada ao provedor pode levar até 45s (server/ia/client.js). O axios global
// corta em 30s: sem este timeout próprio, a UI dava erro enquanto o servidor
// concluía E REGISTRAVA o consumo — o usuário reenviava e pagava duas vezes.
const TIMEOUT_TESTE_MS = 60_000;

const EXEMPLOS_BLOCO = [
  'Cardápio ou tabela de produtos',
  'Política de troca e devolução',
  'Perguntas frequentes',
  'Área e prazo de entrega',
];

function Secao({ titulo, children, acao }) {
  return (
    <section className="bg-white rounded-2xl border border-black/[0.06]">
      <header className="flex items-center gap-2 px-4 pt-3.5 pb-2.5 border-b border-black/[0.05]">
        <span className="section-bar" />
        <h2 className="font-display font-bold text-sm text-stone-800 flex-1">{titulo}</h2>
        {acao}
      </header>
      <div className="p-4 space-y-3">{children}</div>
    </section>
  );
}

function Contador({ atual, limite }) {
  const n = Number(atual) || 0;
  const max = Number(limite) || 0;
  const perto = max > 0 && n > max * 0.9;
  return (
    <span className={`font-mono text-[11px] ${max > 0 && n > max ? 'text-red-600' : perto ? 'text-amber-600' : 'text-stone-400'}`}>
      {n.toLocaleString('pt-BR')}/{max.toLocaleString('pt-BR')}
    </span>
  );
}

// Sem plano de IA: nada de formulário — só o convite pra contratar. Quem
// configura provider/modelo/chave é o time Olume (painel do operador), não
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
            vendido à parte. Fale com o time Olume para adicionar ao seu plano.
          </p>
        </div>
      </div>
    </Secao>
  );
}

const FAIXA = {
  verde: { barra: 'bg-emerald-500', texto: 'text-emerald-700', fundo: 'bg-emerald-50 border-emerald-200', rotulo: 'Folgado' },
  amarelo: { barra: 'bg-amber-500', texto: 'text-amber-700', fundo: 'bg-amber-50 border-amber-200', rotulo: 'Ficando grande' },
  vermelho: { barra: 'bg-red-500', texto: 'text-red-700', fundo: 'bg-red-50 border-red-200', rotulo: 'Grande demais' },
};

/** Medidor de espaço. Não é enfeite: a base INTEIRA vai no prompt a cada
 *  mensagem trocada e existe teto mensal de tokens por empresa — base inchada
 *  não deixa só lento, queima o teto mais rápido. */
function Medidor({ medidor }) {
  const f = FAIXA[medidor.faixa] || FAIXA.verde;
  const pct = Math.min(100, Math.round((medidor.caracteres / 25000) * 100));
  return (
    <Secao titulo="Espaço usado pelo agente">
      <div className="flex items-baseline gap-2">
        <span className={`font-display font-bold text-2xl ${f.texto}`}>{medidor.caracteres.toLocaleString('pt-BR')}</span>
        <span className="text-xs text-stone-500">caracteres · ~{medidor.tokensEstimados.toLocaleString('pt-BR')} tokens por mensagem</span>
        <span className={`ml-auto text-[11px] font-semibold px-2 py-0.5 rounded-full border ${f.fundo} ${f.texto}`}>{f.rotulo}</span>
      </div>
      <div className="h-2 rounded-full bg-paper-200 overflow-hidden">
        <div className={`h-full ${f.barra} transition-all`} style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      <p className="text-xs leading-relaxed text-stone-500">
        Tudo que você escreve aqui é enviado ao agente <b>a cada mensagem</b> trocada com um cliente.
        Quanto maior a base, mais rápido o consumo mensal de IA da sua empresa é consumido — e mais lenta
        fica a resposta. Prefira textos diretos e desligue blocos que não estão em uso.
      </p>
    </Secao>
  );
}

// FIL-86: bloco PROPOSTO por upload de arquivo — ainda não existe no banco
// (sem id), por isso não tem ativo/ordem/mover: só título e conteúdo
// editáveis até o admin decidir salvar ou descartar.
function PropostaBloco({ proposta, limiteConteudo, onMudar, onSalvar, onRemover, salvando }) {
  return (
    <div className="rounded-xl border border-brand-700/30 bg-brand-700/[0.03] p-3 space-y-2">
      <input value={proposta.titulo} maxLength={120} placeholder="Título do bloco"
        onChange={(e) => onMudar({ ...proposta, titulo: e.target.value })} className="input-field" />
      <textarea rows={6} value={proposta.conteudo}
        onChange={(e) => onMudar({ ...proposta, conteudo: e.target.value })}
        className="input-field resize-y font-mono text-xs" />
      <div className="flex items-center gap-3">
        <button type="button" onClick={onSalvar} disabled={!proposta.titulo.trim() || !proposta.conteudo.trim() || salvando}
          className="px-4 py-1.5 rounded-lg bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold disabled:opacity-40">
          {salvando ? 'Salvando…' : 'Salvar este bloco'}
        </button>
        <button type="button" onClick={onRemover} disabled={salvando}
          className="text-xs text-stone-500 hover:text-stone-800 disabled:opacity-40">Descartar</button>
        <Contador atual={proposta.conteudo.length} limite={limiteConteudo} />
      </div>
    </div>
  );
}

function Bloco({ bloco, posicao, total, limiteConteudo, editavel, onSalvar, onMover, onRemover, salvando }) {
  const [aberto, setAberto] = useState(false);
  const [titulo, setTitulo] = useState(bloco.titulo);
  const [conteudo, setConteudo] = useState(bloco.conteudo);
  const sujo = titulo !== bloco.titulo || conteudo !== bloco.conteudo;

  useEffect(() => { setTitulo(bloco.titulo); setConteudo(bloco.conteudo); }, [bloco.titulo, bloco.conteudo]);

  return (
    <div className={`rounded-xl border ${bloco.ativo ? 'border-black/[0.08]' : 'border-dashed border-black/[0.12] bg-paper-100'}`}>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button type="button" onClick={() => setAberto((a) => !a)}
          className="flex-1 flex items-center gap-2 text-left min-w-0">
          <span className="font-mono text-[10px] w-5 text-stone-400 shrink-0">{posicao + 1}</span>
          <span className={`text-sm font-medium truncate ${bloco.ativo ? 'text-stone-800' : 'text-stone-400 line-through'}`}>
            {bloco.titulo}
          </span>
          <span className="font-mono text-[10px] text-stone-400 shrink-0">{bloco.conteudo.length.toLocaleString('pt-BR')} car.</span>
        </button>
        {editavel && (
          <>
            <label className="flex items-center gap-1.5 cursor-pointer shrink-0" title={bloco.ativo ? 'Desativar (sai do prompt, texto preservado)' : 'Ativar'}>
              <input type="checkbox" checked={bloco.ativo} disabled={salvando}
                onChange={(e) => onSalvar({ ativo: e.target.checked })}
                className="w-4 h-4 accent-brand-700" />
              <span className="text-[11px] text-stone-500">{bloco.ativo ? 'no ar' : 'desligado'}</span>
            </label>
            {/* Troca de lugar com o VIZINHO na lista exibida (e reescreve a
                ordem dos dois). Mexer só no `ordem` de um bloco empatava com o
                vizinho — e blocos novos nascem todos com ordem 0. */}
            <button type="button" onClick={() => onMover(-1)}
              disabled={salvando || posicao === 0} title="Subir no prompt"
              className="w-6 h-6 rounded text-stone-400 hover:text-stone-700 hover:bg-paper-200 disabled:opacity-30">↑</button>
            <button type="button" onClick={() => onMover(1)}
              disabled={salvando || posicao === total - 1} title="Descer no prompt"
              className="w-6 h-6 rounded text-stone-400 hover:text-stone-700 hover:bg-paper-200 disabled:opacity-30">↓</button>
            <button type="button" onClick={onRemover} disabled={salvando} title="Remover bloco"
              className="w-6 h-6 rounded text-stone-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-30">×</button>
          </>
        )}
      </div>
      {aberto && (
        <div className="px-3 pb-3 space-y-2 border-t border-black/[0.05] pt-3">
          <input value={titulo} disabled={!editavel} maxLength={120}
            onChange={(e) => setTitulo(e.target.value)} className="input-field disabled:opacity-60" />
          <textarea rows={8} value={conteudo} disabled={!editavel}
            onChange={(e) => setConteudo(e.target.value)}
            className="input-field resize-y font-mono text-xs disabled:opacity-60" />
          {editavel && (
            <div className="flex items-center gap-3">
              <button type="button" onClick={() => onSalvar({ titulo, conteudo })} disabled={!sujo || salvando}
                className="px-4 py-1.5 rounded-lg bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold disabled:opacity-40">
                Salvar bloco
              </button>
              <Contador atual={conteudo.length} limite={limiteConteudo} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// FIL-85 — o formulário de pedido da empresa. É um FORMULÁRIO, não um
// form-builder: campo tem rótulo, tipo e "obrigatório", e nada mais. Sem lógica
// condicional, sem múltiplas páginas — a spec fecha o escopo de propósito,
// porque o que precisa ficar simples é a conferência do atendente depois.
function CampoPedido({ campo, posicao, total, tipos, editavel, onMudar, onMover, onRemover }) {
  return (
    <div className="rounded-xl border border-black/[0.08] p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] w-5 text-stone-400 shrink-0">{posicao + 1}</span>
        <input value={campo.rotulo} disabled={!editavel} maxLength={60}
          placeholder="Pergunta/rótulo (ex.: Sabor da pizza)"
          onChange={(e) => onMudar({ ...campo, rotulo: e.target.value })}
          className="input-field flex-1 disabled:opacity-60" />
        <select value={campo.tipo} disabled={!editavel}
          onChange={(e) => onMudar({ ...campo, tipo: e.target.value })}
          aria-label="Tipo do campo"
          className="input-field w-32 shrink-0 disabled:opacity-60">
          {tipos.map((t) => <option key={t} value={t}>{ROTULO_TIPO_CAMPO[t] || t}</option>)}
        </select>
        {editavel && (
          <>
            <button type="button" onClick={() => onMover(-1)} disabled={posicao === 0} title="Subir"
              className="w-6 h-6 rounded text-stone-400 hover:text-stone-700 hover:bg-paper-200 disabled:opacity-30">↑</button>
            <button type="button" onClick={() => onMover(1)} disabled={posicao === total - 1} title="Descer"
              className="w-6 h-6 rounded text-stone-400 hover:text-stone-700 hover:bg-paper-200 disabled:opacity-30">↓</button>
            <button type="button" onClick={onRemover} title="Remover campo"
              className="w-6 h-6 rounded text-stone-400 hover:text-red-600 hover:bg-red-50">×</button>
          </>
        )}
      </div>
      <div className="flex items-center gap-4 pl-7">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={!!campo.obrigatorio} disabled={!editavel}
            onChange={(e) => onMudar({ ...campo, obrigatorio: e.target.checked })}
            className="w-4 h-4 accent-brand-700" />
          <span className="text-[11px] text-stone-600">obrigatório</span>
        </label>
        <span className="text-[11px] text-stone-400">
          {campo.obrigatorio
            ? 'o agente pergunta até o cliente responder'
            : 'o agente preenche só se o cliente disser'}
        </span>
      </div>
      {campo.tipo === 'opcoes' && (
        <div className="pl-7">
          <input value={campo.opcoesTexto ?? (campo.opcoes || []).join(', ')} disabled={!editavel}
            placeholder="Opções separadas por vírgula (ex.: Calabresa, Marguerita, Portuguesa)"
            onChange={(e) => onMudar({ ...campo, opcoesTexto: e.target.value })}
            className="input-field text-xs disabled:opacity-60" />
          <p className="mt-1 text-[11px] text-stone-400">O agente só pode escolher uma destas — nada fora da lista.</p>
        </div>
      )}
    </div>
  );
}

const ROTULO_TIPO_CAMPO = {
  texto: 'Texto', numero: 'Número', data: 'Data', hora: 'Hora', opcoes: 'Opções',
};

const CAMPO_NOVO = { rotulo: '', tipo: 'texto', obrigatorio: false, opcoesTexto: '' };

export default function IaConfig() {
  const { user, isAdmin } = useAuth();
  const [sugestaoAtiva, setSugestaoAtiva] = useState(false);
  const [salvoRecursos, setSalvoRecursos] = useState(false);
  const [instrucoes, setInstrucoes] = useState('');
  const [ficha, setFicha] = useState({});
  const [salvoPerfil, setSalvoPerfil] = useState(false);
  const [erroPerfil, setErroPerfil] = useState('');
  const [novo, setNovo] = useState(null); // { titulo, conteudo } enquanto adiciona
  const [erroBloco, setErroBloco] = useState('');
  const [propostos, setPropostos] = useState(null); // FIL-86: blocos propostos pelo upload, em revisão
  const [erroUpload, setErroUpload] = useState('');
  const [salvandoTodosPropostos, setSalvandoTodosPropostos] = useState(false);
  const arquivoRef = useRef(null);
  const [pergunta, setPergunta] = useState('');
  const [resposta, setResposta] = useState('');
  const [erroTeste, setErroTeste] = useState('');
  // FIL-85 — formulário de pedido em edição local (o rascunho da tela só vai
  // pro servidor no "Salvar formulário").
  const [tituloPedido, setTituloPedido] = useState('');
  const [camposPedido, setCamposPedido] = useState([]);
  const [erroPedido, setErroPedido] = useState('');
  const [salvoPedido, setSalvoPedido] = useState(false);
  const [erroFerramenta, setErroFerramenta] = useState('');
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
  const perfil = useQuery({
    queryKey: ['ia-perfil'],
    queryFn: () => api.get('/ia-perfil').then((r) => r.data),
    enabled: !!user?.iaHabilitada,
  });
  // FIL-85: o que o agente pode FAZER (liga/desliga) + o formulário de pedido.
  const ferramentas = useQuery({
    queryKey: ['ia-ferramentas'],
    queryFn: () => api.get('/ia-ferramentas').then((r) => r.data),
    enabled: !!user?.iaHabilitada,
  });

  useEffect(() => {
    if (geral.data) setSugestaoAtiva(geral.data.ia_sugestao_ativa === 'S');
  }, [geral.data]);

  // Preenche o formulário UMA vez, na primeira carga. Toda mutação de bloco
  // invalida ['ia-perfil']; re-sincronizar a cada refetch jogava fora instruções
  // e ficha ainda não salvas de quem estava no meio da digitação.
  const formInicializado = useRef(false);
  useEffect(() => {
    if (!perfil.data || formInicializado.current) return;
    setInstrucoes(perfil.data.instrucoes || '');
    setFicha(perfil.data.ficha || {});
    formInicializado.current = true;
  }, [perfil.data]);

  // Mesma ideia do formulário de perfil: preenche UMA vez, na primeira carga —
  // um refetch no meio da edição jogaria fora os campos ainda não salvos.
  const pedidoInicializado = useRef(false);
  useEffect(() => {
    if (!ferramentas.data || pedidoInicializado.current) return;
    const t = ferramentas.data.template;
    setTituloPedido(t?.titulo || '');
    setCamposPedido((t?.campos || []).map((c) => ({ ...c, opcoesTexto: (c.opcoes || []).join(', ') })));
    pedidoInicializado.current = true;
  }, [ferramentas.data]);

  const alternarFerramenta = useMutation({
    mutationFn: ({ nome, ativo }) => api.put(`/ia-ferramentas/${nome}`, { ativo }),
    onSuccess: () => { setErroFerramenta(''); qc.invalidateQueries({ queryKey: ['ia-ferramentas'] }); },
    onError: (e) => {
      setErroFerramenta(e.response?.data?.error || 'Falha ao mudar a ferramenta.');
      qc.invalidateQueries({ queryKey: ['ia-ferramentas'] });
    },
  });

  const salvarTemplate = useMutation({
    mutationFn: () => api.put('/ia-ferramentas/template', {
      titulo: tituloPedido,
      campos: camposPedido.map((c) => ({
        rotulo: c.rotulo,
        tipo: c.tipo,
        obrigatorio: !!c.obrigatorio,
        // A tela edita as opções como uma linha de texto; o servidor recebe lista.
        opcoes: c.tipo === 'opcoes'
          ? String(c.opcoesTexto ?? '').split(',').map((o) => o.trim()).filter(Boolean)
          : undefined,
      })),
    }),
    onSuccess: () => {
      setErroPedido(''); setSalvoPedido(true);
      qc.invalidateQueries({ queryKey: ['ia-ferramentas'] });
      setTimeout(() => setSalvoPedido(false), 2500);
    },
    onError: (e) => setErroPedido(e.response?.data?.error || 'Falha ao salvar o formulário.'),
  });

  const removerTemplate = useMutation({
    mutationFn: () => api.delete('/ia-ferramentas/template'),
    onSuccess: () => {
      setErroPedido(''); setTituloPedido(''); setCamposPedido([]);
      qc.invalidateQueries({ queryKey: ['ia-ferramentas'] });
    },
    onError: (e) => setErroPedido(e.response?.data?.error || 'Falha ao remover o formulário.'),
  });

  const salvarRecursos = useMutation({
    mutationFn: (ativo) => api.put('/config', { ia_sugestao_ativa: ativo ? 'S' : 'N' }),
    onSuccess: () => {
      setSalvoRecursos(true);
      qc.invalidateQueries({ queryKey: ['config'] });
      setTimeout(() => setSalvoRecursos(false), 2500);
    },
  });

  const salvarPerfil = useMutation({
    mutationFn: () => api.put('/ia-perfil', { instrucoes, ficha }),
    onSuccess: () => {
      setErroPerfil(''); setSalvoPerfil(true);
      qc.invalidateQueries({ queryKey: ['ia-perfil'] });
      setTimeout(() => setSalvoPerfil(false), 2500);
    },
    onError: (e) => setErroPerfil(e.response?.data?.error || 'Falha ao salvar.'),
  });

  const criarBloco = useMutation({
    mutationFn: (b) => api.post('/ia-conhecimento', b),
    onSuccess: () => { setNovo(null); setErroBloco(''); qc.invalidateQueries({ queryKey: ['ia-perfil'] }); },
    onError: (e) => setErroBloco(e.response?.data?.error || 'Falha ao adicionar o bloco.'),
  });
  const editarBloco = useMutation({
    mutationFn: ({ id, ...campos }) => api.put(`/ia-conhecimento/${id}`, campos),
    onSuccess: () => { setErroBloco(''); qc.invalidateQueries({ queryKey: ['ia-perfil'] }); },
    onError: (e) => setErroBloco(e.response?.data?.error || 'Falha ao salvar o bloco.'),
  });
  const removerBloco = useMutation({
    mutationFn: (id) => api.delete(`/ia-conhecimento/${id}`),
    onSuccess: () => { setErroBloco(''); qc.invalidateQueries({ queryKey: ['ia-perfil'] }); },
    onError: (e) => setErroBloco(e.response?.data?.error || 'Falha ao remover o bloco.'),
  });
  // FIL-86: POST /ia-conhecimento/extrair é STATELESS — só devolve blocos
  // PROPOSTOS pra revisão. Quem persiste é o mesmo `criarBloco` de sempre
  // (auditoria + invalidação de cache já existentes na FIL-83).
  const enviarArquivo = useMutation({
    mutationFn: (arquivo) => {
      const fd = new FormData();
      fd.append('arquivo', arquivo);
      return api.post('/ia-conhecimento/extrair', fd).then((r) => r.data);
    },
    onSuccess: (d) => { setErroUpload(''); setErroBloco(''); setPropostos(d.blocos); },
    onError: (e) => setErroUpload(e.response?.data?.error || 'Falha ao extrair o arquivo.'),
  });
  // Reordenar = reescrever a `ordem` de quem mudou de posição, em sequência.
  // Na primeira vez costuma tocar em vários (todos nascem com ordem 0); depois,
  // só nos dois que trocaram de lugar.
  const reordenarBlocos = useMutation({
    mutationFn: async (mudancas) => {
      for (const m of mudancas) await api.put(`/ia-conhecimento/${m.id}`, { ordem: m.ordem });
    },
    onSuccess: () => { setErroBloco(''); qc.invalidateQueries({ queryKey: ['ia-perfil'] }); },
    onError: (e) => setErroBloco(e.response?.data?.error || 'Falha ao reordenar os blocos.'),
  });
  const testar = useMutation({
    mutationFn: () => api.post('/ia-perfil/testar', { pergunta }, { timeout: TIMEOUT_TESTE_MS }).then((r) => r.data),
    onSuccess: (d) => { setErroTeste(''); setResposta(d.resposta); },
    onError: (e) => { setResposta(''); setErroTeste(e.response?.data?.error || 'Falha ao testar.'); },
  });

  if (!user?.iaHabilitada) return <SemPlano />;
  if (config.isLoading || perfil.isLoading) return <div className="p-10 flex justify-center"><Spinner /></div>;

  const dados = perfil.data || {};
  // Espalhados por chave: `{ ...defaults, ...(recebido || {}) }`. Um objeto
  // recebido vazio (ou parcial) não pode apagar os defaults — era o que
  // derrubava a página quando o GET falhava.
  const limites = { ...LIMITES_PADRAO, ...(dados.limites || {}) };
  const medidor = { ...MEDIDOR_VAZIO, ...(dados.medidor || {}) };
  const blocos = dados.blocos || [];
  // Espelho dos limites/tipos do servidor (server/ia/pedidoTemplate.js). Como
  // no medidor, os defaults só cobrem o intervalo entre a falha do GET e o
  // retry — sem eles a página inteira cairia num `.map` de undefined.
  const limitesPedido = ferramentas.data?.limites || { campos: 20, titulo: 80 };
  const tiposPedido = ferramentas.data?.tipos || ['texto', 'numero', 'data', 'hora', 'opcoes'];
  const salvandoBloco = criarBloco.isPending || editarBloco.isPending
    || removerBloco.isPending || reordenarBlocos.isPending;

  /** Move o bloco da posição `idx` em `delta` na lista EXIBIDA e devolve ao
   *  servidor só as ordens que realmente mudaram. */
  const moverBloco = (idx, delta) => {
    const destino = idx + delta;
    if (destino < 0 || destino >= blocos.length) return;
    const lista = [...blocos];
    [lista[idx], lista[destino]] = [lista[destino], lista[idx]];
    const mudancas = [];
    lista.forEach((b, i) => { if (b.ordem !== i) mudancas.push({ id: b.id, ordem: i }); });
    if (mudancas.length) reordenarBlocos.mutate(mudancas);
  };

  // FIL-86 — upload de arquivo -----------------------------------------------
  const escolherArquivo = (e) => {
    const arquivo = e.target.files && e.target.files[0];
    e.target.value = ''; // permite escolher o MESMO arquivo de novo depois de um erro
    if (!arquivo) return;
    setPropostos(null);
    enviarArquivo.mutate(arquivo);
  };

  const mudarProposto = (idx, proposta) => {
    setPropostos((atual) => atual.map((p, i) => (i === idx ? proposta : p)));
  };

  const removerProposto = (idx) => {
    setPropostos((atual) => {
      const restante = atual.filter((_, i) => i !== idx);
      return restante.length ? restante : null;
    });
  };

  const salvarProposto = (idx) => {
    criarBloco.mutate(propostos[idx], { onSuccess: () => removerProposto(idx) });
  };

  const salvarTodosPropostos = async () => {
    setSalvandoTodosPropostos(true);
    setErroBloco('');
    // Fila local, não o state `propostos`: dentro deste laço o state só é
    // atualizado no próximo render, então reler `propostos` a cada iteração
    // repetiria o mesmo bloco já salvo. Sequencial, não Promise.all: cada
    // salvamento conta pro teto de 50 — em paralelo, dois POSTs simultâneos
    // poderiam ambos passar na checagem de contagem e estourar o limite.
    let fila = propostos || [];
    while (fila.length) {
      try {
        await criarBloco.mutateAsync(fila[0]);
        fila = fila.slice(1);
        setPropostos(fila.length ? fila : null);
      } catch (e) {
        setErroBloco(e.response?.data?.error || 'Falha ao salvar um dos blocos — os demais continuam em revisão.');
        break;
      }
    }
    setSalvandoTodosPropostos(false);
  };

  if (perfil.isError) {
    return (
      <div className="max-w-screen-md mx-auto space-y-4">
        <Secao titulo="Agente de IA">
          <p className="text-sm text-stone-700">Não foi possível carregar as instruções e a base de conhecimento.</p>
          <p className="text-xs text-stone-500">{perfil.error?.response?.data?.error || 'Verifique sua conexão e tente de novo.'}</p>
          <button type="button" onClick={() => perfil.refetch()} disabled={perfil.isFetching}
            className="px-5 py-2 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-sm font-semibold disabled:opacity-40">
            {perfil.isFetching ? 'Carregando…' : 'Tentar de novo'}
          </button>
        </Secao>
      </div>
    );
  }

  return (
    <div className="max-w-screen-md mx-auto space-y-4">
      <Secao titulo="Provedor de IA">
        <p className="text-xs text-stone-500">
          Provedor, modelo e chave de API são configurados pelo time Olume — fale com o suporte para trocar.
        </p>
        {config.data?.ativo ? (
          <div className="rounded-lg border border-black/[0.07] px-3.5 py-3 flex items-center gap-3">
            <span className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0">
              <Icon name="bot" size={17} />
            </span>
            <div className="min-w-0">
              {config.data.origem === 'tenant' ? (
                <>
                  <p className="text-sm font-medium text-stone-800">
                    {NOME_PROVEDOR[config.data.provider] || config.data.provider} <span className="font-mono text-stone-400">· {config.data.modelo}</span>
                  </p>
                  {config.data.atualizadoEm && (
                    <p className="text-[11px] text-stone-400">Atualizado em {new Date(config.data.atualizadoEm).toLocaleString('pt-BR')}</p>
                  )}
                </>
              ) : (
                // Credencial GLOBAL do operador (FIL-78): nenhum detalhe de
                // provedor/modelo é exposto por rota de tenant — só que está
                // ativa (a conta é da Olume, não do cliente).
                <p className="text-sm font-medium text-stone-800">Configurado pelo time Olume</p>
              )}
            </div>
          </div>
        ) : (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            Seu plano inclui IA, mas o provedor ainda não foi configurado — fale com o time Olume para ativar.
          </p>
        )}
      </Secao>

      {/* 2 — Instruções ---------------------------------------------------- */}
      <Secao titulo="Instruções do agente">
        <p className="text-xs leading-relaxed text-stone-500">
          Quem é o agente, como ele fala e o que ele pode ou não prometer. Escreva como você explicaria
          a um funcionário novo no primeiro dia. Regras de segurança (não inventar informação, não pedir
          senha ou dado de cartão) já são aplicadas automaticamente e não podem ser desligadas.
        </p>
        <textarea rows={8} value={instrucoes} disabled={!isAdmin}
          onChange={(e) => setInstrucoes(e.target.value)}
          className="input-field resize-y disabled:opacity-60"
          placeholder={'Ex.: Você é a Ana, atendente da Pizzaria do Zé. Trate o cliente pelo nome, seja breve e '
            + 'simpática. Tire dúvidas sobre cardápio, entrega e formas de pagamento. Não dê desconto nem '
            + 'prometa prazo de entrega — nesses casos, diga que vai confirmar com a equipe.'} />
        <div className="flex items-center gap-3">
          <Contador atual={instrucoes.length} limite={limites.instrucoes} />
        </div>
      </Secao>

      {/* 3 — Ficha --------------------------------------------------------- */}
      <Secao titulo="Dados da empresa">
        <p className="text-xs text-stone-500">
          Informações fixas que o agente pode responder na hora. Deixe em branco o que não se aplica.
        </p>
        <div className="space-y-2.5">
          {CAMPOS_FICHA.map((c) => (
            <div key={c.chave}>
              <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1">{c.rotulo}</label>
              <input value={ficha[c.chave] || ''} disabled={!isAdmin} placeholder={c.placeholder}
                onChange={(e) => setFicha((f) => ({ ...f, [c.chave]: e.target.value }))}
                className="input-field disabled:opacity-60" />
            </div>
          ))}
        </div>
        {erroPerfil && <p className="text-xs text-red-600">{erroPerfil}</p>}
        {isAdmin ? (
          <div className="flex items-center gap-3">
            <button onClick={() => salvarPerfil.mutate()} disabled={salvarPerfil.isPending}
              className="px-6 py-2.5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-sm font-semibold disabled:opacity-40">
              {salvarPerfil.isPending ? 'Salvando…' : 'Salvar instruções e dados'}
            </button>
            {salvoPerfil && <span className="text-xs text-emerald-600 font-medium">✓ Salvo — vale na hora</span>}
          </div>
        ) : (
          <p className="font-mono text-[10px] text-stone-400">somente ADMIN edita</p>
        )}
      </Secao>

      {/* 4 — Base de conhecimento ------------------------------------------ */}
      <Secao
        titulo="Base de conhecimento"
        acao={isAdmin && !novo && !propostos && blocos.length < limites.blocos && (
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => arquivoRef.current?.click()} disabled={enviarArquivo.isPending}
              className="flex items-center gap-1 text-xs font-semibold text-brand-700 hover:text-brand-800 disabled:opacity-40">
              <Icon name="upload" size={14} /> {enviarArquivo.isPending ? 'Extraindo…' : 'Enviar arquivo (PDF, XLSX, CSV)'}
            </button>
            <button type="button" onClick={() => setNovo({ titulo: '', conteudo: '' })}
              className="flex items-center gap-1 text-xs font-semibold text-brand-700 hover:text-brand-800">
              <Icon name="plus" size={14} /> Adicionar bloco
            </button>
          </div>
        )}
      >
        <input ref={arquivoRef} type="file" accept=".pdf,.xlsx,.csv" className="hidden" onChange={escolherArquivo} />
        <p className="text-xs leading-relaxed text-stone-500">
          Textos que o agente consulta para responder: cardápio, políticas, perguntas frequentes.
          Um assunto por bloco — assim dá para desligar o que sai de época sem perder o texto.
        </p>

        {erroUpload && <p className="text-xs text-red-600">{erroUpload}</p>}

        {propostos && (
          <div className="rounded-xl border border-black/[0.08] bg-paper-100 p-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-stone-800">
                {propostos.length} bloco{propostos.length === 1 ? '' : 's'} proposto{propostos.length === 1 ? '' : 's'} — revise antes de salvar
              </p>
              <button type="button" onClick={() => setPropostos(null)} disabled={salvandoTodosPropostos}
                className="text-xs text-stone-500 hover:text-stone-800 disabled:opacity-40 shrink-0">
                Descartar todos
              </button>
            </div>
            <p className="text-xs leading-relaxed text-stone-500">
              Nada foi salvo ainda. Corrija título e conteúdo de cada bloco e salve — individualmente ou todos de uma vez.
            </p>
            <div className="space-y-2">
              {propostos.map((p, i) => (
                <PropostaBloco key={i} proposta={p} limiteConteudo={limites.blocoConteudo}
                  onMudar={(nova) => mudarProposto(i, nova)}
                  onSalvar={() => salvarProposto(i)}
                  onRemover={() => removerProposto(i)}
                  salvando={criarBloco.isPending || salvandoTodosPropostos} />
              ))}
            </div>
            <button type="button" onClick={salvarTodosPropostos} disabled={salvandoTodosPropostos || criarBloco.isPending}
              className="px-4 py-1.5 rounded-lg bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold disabled:opacity-40">
              {salvandoTodosPropostos ? 'Salvando todos…' : 'Salvar todos'}
            </button>
          </div>
        )}

        {blocos.length === 0 && !novo && !propostos && (
          // Estado vazio que ENSINA o que escrever — é a primeira tela de quem
          // acabou de contratar.
          <div className="rounded-xl border border-dashed border-black/[0.12] p-4 text-center">
            <p className="text-sm font-medium text-stone-700">Nenhum bloco ainda</p>
            <p className="mt-1 text-xs text-stone-500">Comece por um destes:</p>
            <div className="mt-2 flex flex-wrap justify-center gap-1.5">
              {EXEMPLOS_BLOCO.map((e) => (
                <button key={e} type="button" disabled={!isAdmin}
                  onClick={() => setNovo({ titulo: e, conteudo: '' })}
                  className="px-2.5 py-1 rounded-full border border-black/[0.08] text-[11px] text-stone-600 hover:border-brand-700 hover:text-brand-700 disabled:opacity-50">
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-2">
          {blocos.map((b, i) => (
            <Bloco key={b.id} bloco={b} posicao={i} total={blocos.length}
              limiteConteudo={limites.blocoConteudo} editavel={isAdmin} salvando={salvandoBloco}
              onSalvar={(campos) => editarBloco.mutate({ id: b.id, ...campos })}
              onMover={(delta) => moverBloco(i, delta)}
              onRemover={() => removerBloco.mutate(b.id)} />
          ))}
        </div>

        {novo && (
          <div className="rounded-xl border border-brand-700/30 bg-brand-700/[0.03] p-3 space-y-2">
            <input autoFocus value={novo.titulo} maxLength={120} placeholder="Título do bloco (ex.: Cardápio)"
              onChange={(e) => setNovo((n) => ({ ...n, titulo: e.target.value }))} className="input-field" />
            <textarea rows={6} value={novo.conteudo} placeholder="Cole aqui o conteúdo. Texto simples, direto ao ponto."
              onChange={(e) => setNovo((n) => ({ ...n, conteudo: e.target.value }))}
              className="input-field resize-y font-mono text-xs" />
            <div className="flex items-center gap-3">
              <button type="button" onClick={() => criarBloco.mutate(novo)}
                disabled={!novo.titulo.trim() || !novo.conteudo.trim() || criarBloco.isPending}
                className="px-4 py-1.5 rounded-lg bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold disabled:opacity-40">
                {criarBloco.isPending ? 'Adicionando…' : 'Adicionar'}
              </button>
              <button type="button" onClick={() => { setNovo(null); setErroBloco(''); }}
                className="text-xs text-stone-500 hover:text-stone-800">Cancelar</button>
              <Contador atual={novo.conteudo.length} limite={limites.blocoConteudo} />
            </div>
          </div>
        )}

        {erroBloco && <p className="text-xs text-red-600">{erroBloco}</p>}
        <p className="font-mono text-[10px] text-stone-400">
          {blocos.length}/{limites.blocos} blocos
        </p>
      </Secao>

      {/* 5 — Ações do agente (FIL-85) --------------------------------------- */}
      <Secao titulo="Ações do agente">
        <p className="text-xs leading-relaxed text-stone-500">
          Além de responder, o agente pode agir dentro da conversa. Ele nunca cria etiqueta nova nem apaga
          informação: preenche o cadastro com o que o cliente informar, classifica a conversa com as etiquetas
          que você já cadastrou e registra pedidos que a equipe confere depois. Passar o atendimento para uma
          pessoa está sempre disponível e não pode ser desligado.
        </p>
        <div className="space-y-2">
          {(ferramentas.data?.ferramentas || []).map((f) => {
            const semFormulario = f.exigeTemplate && !ferramentas.data?.template;
            return (
              <label key={f.nome} className="flex items-start gap-3 rounded-xl border border-black/[0.07] px-3.5 py-3 cursor-pointer">
                <input type="checkbox" checked={f.ativo} disabled={!isAdmin || alternarFerramenta.isPending}
                  onChange={(e) => alternarFerramenta.mutate({ nome: f.nome, ativo: e.target.checked })}
                  className="w-4 h-4 mt-0.5 accent-brand-700 disabled:opacity-60" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-stone-800">{f.rotulo}</span>
                  <span className="block text-xs leading-relaxed text-stone-500 mt-0.5">{f.ajuda}</span>
                  {f.ativo && semFormulario && (
                    <span className="mt-1.5 inline-block text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1">
                      Configure o formulário abaixo — sem ele o agente não registra pedido.
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
        {erroFerramenta && <p className="text-xs text-red-600">{erroFerramenta}</p>}
        {!isAdmin && <p className="font-mono text-[10px] text-stone-400">somente ADMIN edita</p>}
      </Secao>

      {/* 6 — Formulário de pedido (FIL-85) ---------------------------------- */}
      <Secao
        titulo="Formulário de pedido"
        acao={isAdmin && camposPedido.length < (limitesPedido.campos || 20) && (
          <button type="button" onClick={() => setCamposPedido((c) => [...c, { ...CAMPO_NOVO }])}
            className="flex items-center gap-1 text-xs font-semibold text-brand-700 hover:text-brand-800">
            <Icon name="plus" size={14} /> Adicionar campo
          </button>
        )}
      >
        <p className="text-xs leading-relaxed text-stone-500">
          O que o agente precisa perguntar para registrar um pedido ou agendamento. Cada pedido entra como
          <b> rascunho</b> e aparece para a equipe conferir no atendimento — nada é enviado para outro sistema.
          Um formulário por empresa.
        </p>

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1">Título</label>
          <input value={tituloPedido} disabled={!isAdmin} maxLength={limitesPedido.titulo || 80}
            placeholder="Ex.: Pedido de delivery · Agendamento de consulta"
            onChange={(e) => setTituloPedido(e.target.value)}
            className="input-field disabled:opacity-60" />
        </div>

        {camposPedido.length === 0 ? (
          <div className="rounded-xl border border-dashed border-black/[0.12] p-4 text-center">
            <p className="text-sm font-medium text-stone-700">Nenhum campo ainda</p>
            <p className="mt-1 text-xs text-stone-500">
              Comece pelo que a sua equipe precisa saber para atender: item, quantidade, data, endereço.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {camposPedido.map((campo, i) => (
              <CampoPedido key={i} campo={campo} posicao={i} total={camposPedido.length}
                tipos={tiposPedido} editavel={isAdmin}
                onMudar={(novo) => setCamposPedido((lista) => lista.map((c, j) => (j === i ? novo : c)))}
                onMover={(delta) => setCamposPedido((lista) => {
                  const destino = i + delta;
                  if (destino < 0 || destino >= lista.length) return lista;
                  const copia = [...lista];
                  [copia[i], copia[destino]] = [copia[destino], copia[i]];
                  return copia;
                })}
                onRemover={() => setCamposPedido((lista) => lista.filter((_, j) => j !== i))} />
            ))}
          </div>
        )}

        {erroPedido && <p className="text-xs text-red-600">{erroPedido}</p>}
        {isAdmin && (
          <div className="flex items-center gap-3 flex-wrap">
            <button type="button" onClick={() => salvarTemplate.mutate()}
              disabled={salvarTemplate.isPending || !tituloPedido.trim() || !camposPedido.length}
              className="px-6 py-2.5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-sm font-semibold disabled:opacity-40">
              {salvarTemplate.isPending ? 'Salvando…' : 'Salvar formulário'}
            </button>
            {salvoPedido && <span className="text-xs text-emerald-600 font-medium">✓ Salvo — vale na hora</span>}
            {ferramentas.data?.template && (
              <button type="button" onClick={() => removerTemplate.mutate()} disabled={removerTemplate.isPending}
                className="text-xs text-stone-500 hover:text-red-600 disabled:opacity-40">
                Remover formulário
              </button>
            )}
            <span className="font-mono text-[10px] text-stone-400 ml-auto">
              {camposPedido.length}/{limitesPedido.campos || 20} campos
            </span>
          </div>
        )}
      </Secao>

      {/* 7 — Medidor -------------------------------------------------------- */}
      <Medidor medidor={medidor} />

      {/* 8 — Testar --------------------------------------------------------- */}
      {isAdmin && (
        <Secao titulo="Testar o agente">
          <p className="text-xs text-stone-500">
            Faça uma pergunta como um cliente faria. A resposta usa exatamente a configuração salva acima —
            e consome tokens do seu plano, igual a um atendimento real.
          </p>
          <div className="flex gap-2">
            <input value={pergunta} placeholder="Ex.: vocês entregam no Setor Bueno?"
              onChange={(e) => setPergunta(e.target.value)}
              // Cada teste é uma chamada paga ao provedor: Enter repetido não
              // pode disparar outra enquanto a anterior está no ar.
              onKeyDown={(e) => { if (e.key === 'Enter' && pergunta.trim() && !testar.isPending) testar.mutate(); }}
              className="input-field flex-1" />
            <button type="button" onClick={() => testar.mutate()} disabled={!pergunta.trim() || testar.isPending}
              className="px-5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-sm font-semibold disabled:opacity-40 shrink-0">
              {testar.isPending ? '…' : 'Testar'}
            </button>
          </div>
          {erroTeste && <p className="text-xs text-red-600">{erroTeste}</p>}
          {resposta && (
            <div className="rounded-xl border border-black/[0.07] bg-paper-100 px-3.5 py-3">
              <p className="text-[10px] font-mono uppercase tracking-wide text-stone-400 mb-1">Resposta do agente</p>
              <p className="text-sm text-stone-800 whitespace-pre-wrap">{resposta}</p>
            </div>
          )}
        </Secao>
      )}

      {/* 9 — Recursos ------------------------------------------------------- */}
      <Secao titulo="Recursos para o atendente">
        <label className="flex items-start gap-3 cursor-pointer">
          <input type="checkbox" checked={sugestaoAtiva} disabled={!config.data?.ativo || !isAdmin}
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
    </div>
  );
}
