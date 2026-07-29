import { useState } from 'react';
import { Link } from 'react-router-dom';
import Brand, { BrandMark } from '../components/ui/Brand';
import Icon from '../components/ui/Icon';
import ThemeMenu from '../components/ui/ThemeMenu';

const dores = [
  {
    titulo: 'Fila sem dono.',
    texto: 'A conversa espera, a equipe se atropela e ninguém sabe quem resolve.',
  },
  {
    titulo: 'Cliente repetindo tudo.',
    texto: 'Sem histórico compartilhado, cada transferência recomeça o atendimento.',
  },
  {
    titulo: 'Gestor sem visibilidade.',
    texto: 'Sem filas e indicadores, o gargalo só aparece depois da reclamação.',
  },
];

const recursos = [
  {
    id: 'atendimento',
    rotulo: 'Atendimento',
    icon: 'inbox',
    titulo: 'A conversa inteira no mesmo contexto.',
    texto: 'A equipe encontra histórico, protocolo, contato, tags, anexos e notas internas antes de responder.',
    itens: ['Filas Aguardando e Minhas', 'Busca e filtros por canal', 'Transferência e finalização', 'Atalhos e sugestão de resposta'],
  },
  {
    id: 'operacao',
    rotulo: 'Operação',
    icon: 'pulse',
    titulo: 'A gestão acompanha sem interromper.',
    texto: 'Filas, presença, carga da equipe, tempos e histórico ficam visíveis para decisões baseadas no que está acontecendo agora.',
    itens: ['Operação ao vivo', 'Indicadores de desempenho', 'Histórico pesquisável', 'Departamentos e atendentes'],
  },
  {
    id: 'automacao',
    rotulo: 'Automação',
    icon: 'flow',
    titulo: 'Automatize com regra, limite e propósito.',
    texto: 'Fluxos, campanhas e IA assumem tarefas repetitivas sem tirar da gestão o controle sobre horários, acessos e comportamento.',
    itens: ['Fluxos de atendimento', 'Campanhas ativas', 'Agente de IA configurável', 'Permissões específicas para IA'],
  },
  {
    id: 'controle',
    rotulo: 'Canais e controle',
    icon: 'shield',
    titulo: 'Cada pessoa vê e faz o que precisa.',
    texto: 'Canais oficiais, papéis definidos e trilhas de auditoria mantêm a operação segura mesmo quando a equipe e a carteira crescem.',
    itens: ['WhatsApp Cloud API oficial', 'Controle por perfil', 'Múltiplos canais e empresas', 'Acessos de suporte auditados'],
  },
];

const etapas = [
  ['Mensagem chega', 'O WhatsApp oficial recebe e registra o contexto.'],
  ['Fila organiza', 'Regras e departamentos direcionam o assunto.'],
  ['Equipe atende', 'A pessoa certa assume, responde e transfere quando necessário.'],
  ['Gestão acompanha', 'Indicadores e histórico revelam gargalos e oportunidades.'],
];

const seguranca = [
  ['Canal oficial', 'Integração direta com a WhatsApp Cloud API da Meta.'],
  ['Acesso por função', 'Administradores, supervisores, atendentes e auditores têm permissões próprias.'],
  ['Empresas isoladas', 'Cada cliente opera em seu próprio contexto dentro da plataforma multiempresa.'],
  ['Ações rastreáveis', 'Histórico e auditoria registram decisões e acessos de suporte.'],
];

const emailComercial = import.meta.env.VITE_COMERCIAL_EMAIL || 'comercial@olume.com.br';

function ProductPreview() {
  const conversas = [
    ['AM', 'Ana Martins', 'Preciso atualizar meu cadastro.', '2 min', 'Vendas'],
    ['LC', 'Lucas Costa', 'Qual é o prazo de entrega?', '8 min', 'Suporte'],
    ['FB', 'Fernanda Braga', 'Quero falar sobre meu pedido.', '12 min', 'Geral'],
    ['RS', 'Rafael Souza', 'Ainda não recebi minha nota.', '18 min', 'Financeiro'],
  ];

  return (
    <figure className="landing-product-wrap landing-enter landing-enter-delay">
      <div className="landing-product-frame" role="img" aria-label="Visão do Olume Chat com fila de conversas, atendimento e indicadores da operação">
        <div className="landing-product-topbar" aria-hidden="true">
          <div className="flex items-center gap-2">
            <span className="landing-mini-mark"><BrandMark inverse className="h-4 w-4" /></span>
            <strong>Conversas</strong>
          </div>
          <div className="flex items-center gap-2 text-[9px] text-[#4D625C]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#1FB88F]" />
            Operação online
          </div>
        </div>

        <div className="landing-product-grid" aria-hidden="true">
          <div className="landing-product-rail">
            {['inbox', 'history', 'users', 'chart', 'settings'].map((icon, index) => (
              <span key={icon} className={index === 0 ? 'is-active' : ''}><Icon name={icon} size={14} /></span>
            ))}
          </div>

          <div className="landing-conversation-list">
            <div className="p-3">
              <div className="flex items-center justify-between">
                <strong className="text-[11px]">Conversas</strong>
                <span className="landing-mock-primary">+ Nova</span>
              </div>
              <div className="mt-2 flex items-center gap-1.5 rounded-md border border-[#D3E0DB] bg-white px-2 py-1.5 text-[8px] text-[#4D625C]">
                <Icon name="search" size={10} />
                Buscar nome ou protocolo
              </div>
              <div className="mt-2 grid grid-cols-2 rounded-md bg-[#E7EFEC] p-0.5 text-center text-[8px]">
                <span className="rounded bg-white py-1 font-semibold text-[#1F7A60]">Aguardando 12</span>
                <span className="py-1 text-[#4D625C]">Minhas 7</span>
              </div>
            </div>
            <div className="border-t border-[#D3E0DB]">
              {conversas.map(([iniciais, nome, mensagem, tempo, setor], index) => (
                <div key={nome} className={`flex gap-2 border-b border-[#E7EFEC] px-3 py-2 ${index === 0 ? 'bg-[#EAFBF5]' : 'bg-white'}`}>
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#123A32] text-[8px] font-bold text-white">{iniciais}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex justify-between gap-2">
                      <strong className="truncate text-[9px]">{nome}</strong>
                      <span className="text-[7px] text-[#6A7E77]">{tempo}</span>
                    </div>
                    <p className="truncate text-[8px] text-[#4D625C]">{mensagem}</p>
                    <span className="mt-0.5 inline-flex items-center gap-1 text-[7px] text-[#1F7A60]">
                      <span className="h-1 w-1 rounded-full bg-[#5BD6AE]" />{setor}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="landing-thread">
            <div className="flex h-11 items-center gap-2 border-b border-[#D3E0DB] px-3">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#123A32] text-[8px] font-bold text-white">AM</span>
              <div className="min-w-0 flex-1">
                <strong className="block truncate text-[10px]">Ana Martins</strong>
                <span className="block text-[7px] text-[#4D625C]">receptiva · protocolo 202607280184</span>
              </div>
              <span className="landing-mock-icon"><Icon name="edit" size={11} /></span>
              <span className="landing-mock-icon"><Icon name="flow" size={11} /></span>
              <span className="landing-mock-icon text-[#B55343]"><Icon name="check" size={11} /></span>
            </div>
            <div className="flex-1 space-y-2 bg-[#F2F6F4] p-3">
              <span className="mx-auto block w-fit rounded-full border border-[#D3E0DB] bg-white px-2 py-1 text-[7px] text-[#4D625C]">Hoje</span>
              <div className="max-w-[64%] rounded-lg rounded-bl-sm bg-white px-3 py-2 text-[8px] leading-4 text-[#20322D]">
                Oi! Preciso atualizar meus dados antes do próximo pedido.
              </div>
              <div className="ml-auto max-w-[67%] rounded-lg rounded-br-sm bg-[#D5F5E9] px-3 py-2 text-[8px] leading-4 text-[#123A32]">
                Olá, Ana! Já encontrei seu cadastro. Pode me confirmar o CNPJ?
                <span className="mt-1 block text-right text-[6px] text-[#1F7A60]">11:42 ✓✓</span>
              </div>
              <div className="mx-auto max-w-[72%] rounded-md border border-[#E5CF98] bg-[#FFF8E5] px-3 py-2 text-[7px] text-[#715112]">
                <strong className="block">NOTA INTERNA</strong>
                Cadastro vinculado ao cliente 99548.
              </div>
            </div>
            <div className="border-t border-[#D3E0DB] bg-white p-2">
              <div className="mb-1.5 flex gap-3 text-[7px]">
                <strong className="text-[#1F7A60]">Mensagem</strong>
                <span className="text-[#4D625C]">Nota interna</span>
              </div>
              <div className="flex items-center gap-2 rounded-md border border-[#CBD8D4] px-2 py-2 text-[8px] text-[#6A7E77]">
                Digite uma mensagem…
                <span className="ml-auto flex h-6 w-6 items-center justify-center rounded bg-[#1F7A60] text-white">→</span>
              </div>
            </div>
          </div>

          <div className="landing-live-panel">
            <div className="border-b border-[#D3E0DB] p-3">
              <span className="text-[8px] text-[#4D625C]">Operação ao vivo</span>
              <strong className="mt-1 block text-[11px]">Fila de atendimentos</strong>
            </div>
            <div className="grid grid-cols-2 gap-px bg-[#D3E0DB]">
              {[['Em espera', '12'], ['Em atendimento', '38'], ['Equipe online', '9'], ['Tempo médio', '02:47']].map(([label, value]) => (
                <div key={label} className="bg-white p-3">
                  <span className="block text-[7px] text-[#4D625C]">{label}</span>
                  <strong className="mt-1 block text-sm">{value}</strong>
                </div>
              ))}
            </div>
            <div className="p-3">
              <strong className="text-[9px]">Filas por departamento</strong>
              {[['Suporte', 78], ['Vendas', 54], ['Financeiro', 32]].map(([label, width]) => (
                <div key={label} className="mt-3">
                  <div className="mb-1 flex justify-between text-[7px]"><span>{label}</span><span>{Math.round(width / 5)}</span></div>
                  <div className="h-1 rounded-full bg-[#E7EFEC]"><div className="h-full rounded-full bg-[#1F7A60]" style={{ width: `${width}%` }} /></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <figcaption className="mt-3 text-center text-xs text-stone-500">
        Fila, conversa, contexto e operação no mesmo ambiente.
      </figcaption>
    </figure>
  );
}

function FeaturePreview({ tipo }) {
  if (tipo === 'operacao') {
    return (
      <div className="landing-feature-screen" aria-label="Prévia da operação ao vivo">
        <div className="landing-feature-screen-head"><Icon name="pulse" size={15} /><strong>Operação ao vivo</strong><span>Atualizado agora</span></div>
        <div className="grid gap-3 p-4 sm:grid-cols-[1.15fr_0.85fr]">
          <div>
            <p className="landing-screen-label">Filas por departamento</p>
            {[['Suporte', '18 aguardando', 84], ['Vendas', '7 aguardando', 52], ['Financeiro', '3 aguardando', 29]].map(([nome, detalhe, largura]) => (
              <div key={nome} className="border-b border-paper-300 py-3 last:border-0">
                <div className="flex items-center justify-between gap-3 text-xs"><strong>{nome}</strong><span className="text-stone-500">{detalhe}</span></div>
                <div className="mt-2 h-1.5 rounded-full bg-paper-200"><div className="h-full rounded-full bg-brand-700" style={{ width: `${largura}%` }} /></div>
              </div>
            ))}
          </div>
          <div className="border-t border-paper-300 pt-4 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
            <p className="landing-screen-label">Equipe agora</p>
            {[['Ana Martins', 'Atendendo', true], ['Carlos Lima', 'Disponível', true], ['Marina Alves', 'Em pausa', false]].map(([nome, estado, online]) => (
              <div key={nome} className="flex items-center gap-2 py-2.5 text-xs">
                <span className={`h-2 w-2 rounded-full ${online ? 'bg-brand-500' : 'bg-amber-500'}`} />
                <strong className="flex-1">{nome}</strong>
                <span className="text-stone-500">{estado}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (tipo === 'automacao') {
    return (
      <div className="landing-feature-screen" aria-label="Prévia de um fluxo automatizado">
        <div className="landing-feature-screen-head"><Icon name="flow" size={15} /><strong>Fluxo · Menu principal</strong><span>Ativo</span></div>
        <div className="flex min-h-[260px] items-center justify-center overflow-hidden bg-paper-100 p-5">
          <div className="landing-flow">
            <span><Icon name="inbox" size={13} /> Mensagem recebida</span>
            <i />
            <span><Icon name="bot" size={13} /> Enviar boas-vindas</span>
            <i />
            <span><Icon name="flow" size={13} /> Escolher departamento</span>
            <div className="grid grid-cols-2 gap-8">
              <b>Vendas</b>
              <b>Suporte</b>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (tipo === 'controle') {
    return (
      <div className="landing-feature-screen" aria-label="Prévia de canais e permissões">
        <div className="landing-feature-screen-head"><Icon name="shield" size={15} /><strong>Canais e controle</strong><span>Workspace seguro</span></div>
        <div className="divide-y divide-paper-300 p-4">
          {[
            ['phone', 'Atendimento principal', 'WhatsApp conectado', 'Ativo'],
            ['users', 'Equipe de atendimento', '9 pessoas · 3 departamentos', 'Gerenciar'],
            ['shield', 'Perfis e permissões', 'Admin · Supervisor · Atendente · Auditor', 'Revisar'],
            ['history', 'Auditoria', 'Ações e acessos registrados', 'Consultar'],
          ].map(([icon, title, detail, action]) => (
            <div key={title} className="flex items-center gap-3 py-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50 text-brand-700"><Icon name={icon} size={16} /></span>
              <div className="min-w-0 flex-1"><strong className="block text-xs text-ink-950">{title}</strong><span className="block truncate text-[11px] text-stone-500">{detail}</span></div>
              <span className="rounded-md border border-paper-400 px-2 py-1 text-[10px] text-stone-600">{action}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="landing-feature-screen" aria-label="Prévia da central de conversas">
      <div className="landing-feature-screen-head"><Icon name="inbox" size={15} /><strong>Central de conversas</strong><span>7 em atendimento</span></div>
      <div className="grid min-h-[260px] grid-cols-[0.82fr_1.18fr]">
        <div className="border-r border-paper-300 p-3">
          <div className="grid grid-cols-2 rounded-md bg-paper-200 p-0.5 text-center text-[10px]"><strong className="rounded bg-white py-1.5 text-brand-700">Aguardando 12</strong><span className="py-1.5 text-stone-500">Minhas 7</span></div>
          {['Ana Martins', 'Lucas Costa', 'Fernanda Braga'].map((nome, index) => (
            <div key={nome} className={`mt-2 flex items-center gap-2 rounded-md p-2 ${index === 0 ? 'bg-brand-50' : ''}`}>
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ink-800 text-[8px] text-white">{nome.split(' ').map((n) => n[0]).join('')}</span>
              <div className="min-w-0"><strong className="block truncate text-[10px]">{nome}</strong><span className="block truncate text-[9px] text-stone-500">Nova mensagem recebida</span></div>
            </div>
          ))}
        </div>
        <div className="flex flex-col bg-paper-100 p-3">
          <span className="w-fit rounded-lg bg-white px-3 py-2 text-[10px]">Preciso atualizar meus dados.</span>
          <span className="ml-auto mt-3 w-fit max-w-[82%] rounded-lg bg-brand-100 px-3 py-2 text-[10px] text-ink-800">Já encontrei seu cadastro. Pode confirmar o CNPJ?</span>
          <div className="mt-auto flex items-center rounded-md border border-paper-400 bg-white px-3 py-2 text-[10px] text-stone-500">Digite uma mensagem…<span className="ml-auto text-brand-700">Enviar →</span></div>
        </div>
      </div>
    </div>
  );
}

export default function Landing() {
  const [form, setForm] = useState({ nome: '', empresa: '', email: '', equipe: '' });
  const [recursoAtivo, setRecursoAtivo] = useState('atendimento');
  const recurso = recursos.find((item) => item.id === recursoAtivo) || recursos[0];

  function atualizar(campo) {
    return (event) => setForm((atual) => ({ ...atual, [campo]: event.target.value }));
  }

  function solicitarDemonstracao(event) {
    event.preventDefault();
    const assunto = encodeURIComponent(`Demonstração Olume Chat para ${form.empresa}`);
    const corpo = encodeURIComponent([
      `Olá, meu nome é ${form.nome}.`,
      '',
      `Empresa: ${form.empresa}`,
      `E-mail: ${form.email}`,
      `Tamanho da equipe: ${form.equipe}`,
      '',
      'Quero conhecer o Olume Chat e entender como organizar nossa operação de atendimento.',
    ].join('\n'));
    window.location.href = `mailto:${emailComercial}?subject=${assunto}&body=${corpo}`;
  }

  return (
    <div className="landing-page min-h-screen bg-paper-50 text-stone-900">
      <a href="#conteudo" className="sr-only z-[100] rounded-md bg-white px-4 py-3 text-sm font-semibold text-ink-950 focus:not-sr-only focus:fixed focus:left-4 focus:top-4">
        Ir para o conteúdo
      </a>

      <header className="landing-nav-wrap sticky top-0 z-50 px-3 pt-3 sm:px-5">
        <div className="landing-nav mx-auto flex h-[58px] max-w-[1240px] items-center gap-4 rounded-full bg-[#071A15] px-3.5 text-white sm:px-5">
          <Link to="/" aria-label="Olume Chat, página inicial" className="shrink-0 rounded-md">
            <Brand inverse />
          </Link>
          <nav aria-label="Navegação principal" className="mx-auto hidden items-center gap-7 text-[13px] font-medium text-white/75 lg:flex">
            <a href="#produto" className="hover:text-white">Produto</a>
            <a href="#recursos" className="hover:text-white">Recursos</a>
            <a href="#como-funciona" className="hover:text-white">Como funciona</a>
            <a href="#seguranca" className="hover:text-white">Segurança</a>
          </nav>
          <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
            <ThemeMenu inverse />
            <Link to="/login" className="hidden min-h-10 items-center px-3 text-[13px] font-semibold text-white/75 hover:text-white md:inline-flex">
              Entrar
            </Link>
            <a href="#demonstracao" className="landing-mint-action inline-flex min-h-10 items-center justify-center rounded-full bg-[#5BD6AE] px-3.5 text-xs font-bold text-[#071A15] hover:bg-[#7BE0C2] sm:px-5 sm:text-[13px]">
              <span className="hidden sm:inline">Solicitar demonstração</span>
              <span className="sm:hidden">Demonstração</span>
              <span className="ml-2" aria-hidden="true">→</span>
            </a>
          </div>
        </div>
      </header>

      <main id="conteudo">
        <section id="produto" className="relative border-b border-paper-300">
          <div className="mx-auto grid min-h-[calc(100svh-82px)] max-w-[1320px] items-center gap-12 px-5 py-14 sm:px-8 lg:grid-cols-[0.86fr_1.14fr] lg:gap-14 lg:py-16">
            <div className="landing-enter relative z-10 max-w-[630px]">
              <p className="mb-5 flex items-center gap-3 text-sm font-semibold text-stone-700">
                <span className="h-2.5 w-2.5 bg-[#5BD6AE]" aria-hidden="true" />
                Atendimento que não perde o fio
              </p>
              <h1 className="landing-display max-w-[12ch] text-[clamp(3rem,5.2vw,5.1rem)] leading-[0.91] text-ink-950">
                Atenda no tempo certo. <span className="landing-highlight">Sem perder o contexto.</span>
              </h1>
              <p className="mt-7 max-w-[590px] text-lg leading-8 text-stone-600">
                WhatsApp, filas, equipe e automações em uma operação que todo mundo consegue acompanhar.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <a href="#demonstracao" className="landing-cta landing-mint-action inline-flex min-h-12 items-center justify-center rounded-xl bg-[#5BD6AE] px-6 text-sm font-bold text-[#071A15] hover:bg-[#7BE0C2]">
                  Solicitar demonstração <span className="ml-3" aria-hidden="true">→</span>
                </a>
                <a href="#recursos" className="landing-cta inline-flex min-h-12 items-center justify-center rounded-xl border border-ink-950 bg-transparent px-6 text-sm font-bold text-ink-950 hover:bg-ink-950 hover:text-white">
                  Ver a plataforma
                </a>
              </div>
            </div>

            <ProductPreview />
          </div>

          <div className="mx-auto grid max-w-[1240px] border-t border-paper-300 px-5 sm:grid-cols-3 sm:px-8">
            {[
              ['shield', 'WhatsApp Cloud API oficial', 'Conexão estável e segura.'],
              ['users', 'Controle por perfil', 'Permissões na medida.'],
              ['history', 'Operação auditável', 'Histórico, trilhas e protocolos.'],
            ].map(([icon, title, text], index) => (
              <div key={title} className={`flex items-center gap-3 py-5 sm:px-6 ${index > 0 ? 'border-t border-paper-300 sm:border-l sm:border-t-0' : ''}`}>
                <span className="flex h-9 w-9 items-center justify-center rounded-full border border-brand-300 text-brand-700"><Icon name={icon} size={16} /></span>
                <div><strong className="block text-sm text-ink-950">{title}</strong><span className="text-xs text-stone-500">{text}</span></div>
              </div>
            ))}
          </div>
        </section>

        <section className="bg-[#071A15] text-[#F2F7F5]">
          <div className="mx-auto max-w-[1240px] px-5 py-20 sm:px-8 lg:py-24">
            <h2 className="landing-display max-w-[850px] text-[clamp(2.6rem,5vw,4.8rem)] leading-[0.94]">
              O problema não é só responder.
            </h2>
            <div className="landing-pain-grid mt-12">
              {dores.map((dor) => (
                <article key={dor.titulo} className="landing-pain-item">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full border border-[#5BD6AE] text-[#5BD6AE]" aria-hidden="true">×</span>
                  <div>
                    <h3 className="text-xl font-bold">{dor.titulo}</h3>
                    <p className="mt-2 max-w-[34ch] text-sm leading-6 text-[#A9BBB5]">{dor.texto}</p>
                  </div>
                </article>
              ))}
            </div>
            <p className="mt-12 border-t border-[#2D403A] pt-6 text-center text-lg font-bold text-[#5BD6AE]">
              O Olume Chat organiza o caminho inteiro da conversa.
            </p>
          </div>
        </section>

        <section id="recursos" className="border-b border-paper-300">
          <div className="mx-auto max-w-[1240px] px-5 py-20 sm:px-8 lg:py-28">
            <div className="grid gap-8 lg:grid-cols-[0.78fr_1.22fr] lg:items-end">
              <h2 className="landing-display max-w-[620px] text-[clamp(2.7rem,4.6vw,4.6rem)] leading-[0.96] text-ink-950">
                O produto acompanha a operação real.
              </h2>
              <p className="max-w-[620px] text-base leading-7 text-stone-600 lg:justify-self-end">
                Cada módulo corresponde a uma tarefa que já existe no Olume Chat — atender, distribuir, automatizar, acompanhar e controlar.
              </p>
            </div>

            <div className="mt-12 grid gap-5 lg:grid-cols-[310px_1fr]">
              <div className="flex gap-2 overflow-x-auto pb-1 lg:block lg:space-y-2" role="tablist" aria-label="Recursos da plataforma">
                {recursos.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={recursoAtivo === item.id}
                    onClick={() => setRecursoAtivo(item.id)}
                    className={`shrink-0 min-h-12 rounded-xl border px-4 text-left text-sm font-bold lg:flex lg:w-full lg:items-center lg:gap-3 ${
                      recursoAtivo === item.id
                        ? 'border-ink-950 bg-ink-950 text-white'
                        : 'border-paper-400 bg-white text-stone-700 hover:border-brand-500 hover:text-brand-800'
                    }`}
                  >
                    <Icon name={item.icon} size={17} className="hidden lg:block" />
                    {item.rotulo}
                    <span className="ml-auto hidden lg:inline" aria-hidden="true">→</span>
                  </button>
                ))}
              </div>

              <div className="grid overflow-hidden rounded-xl border border-paper-400 bg-white lg:grid-cols-[0.88fr_1.12fr]">
                <div className="p-6 sm:p-8 lg:p-10">
                  <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-700"><Icon name={recurso.icon} size={19} /></span>
                  <h3 className="mt-6 text-2xl font-bold leading-tight tracking-[-0.025em] text-ink-950 sm:text-3xl">{recurso.titulo}</h3>
                  <p className="mt-4 text-sm leading-7 text-stone-600">{recurso.texto}</p>
                  <ul className="mt-6 space-y-3">
                    {recurso.itens.map((item) => (
                      <li key={item} className="flex items-center gap-3 text-sm text-stone-700">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-100 text-brand-800"><Icon name="check" size={12} /></span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="border-t border-paper-300 bg-paper-100 p-4 sm:p-6 lg:border-l lg:border-t-0">
                  <FeaturePreview tipo={recurso.id} />
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="como-funciona" className="bg-paper-100">
          <div className="mx-auto max-w-[1240px] px-5 py-20 sm:px-8 lg:py-28">
            <div className="max-w-[820px]">
              <h2 className="landing-display text-[clamp(2.7rem,4.6vw,4.6rem)] leading-[0.96] text-ink-950">
                Da mensagem ao aprendizado da equipe.
              </h2>
              <p className="mt-5 max-w-[650px] text-base leading-7 text-stone-600">
                O fluxo é simples para quem atende e transparente para quem gerencia.
              </p>
            </div>
            <ol className="landing-steps mt-14">
              {etapas.map(([title, text], index) => (
                <li key={title}>
                  <span>{index + 1}</span>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="seguranca" className="border-y border-paper-300 bg-white">
          <div className="mx-auto grid max-w-[1240px] gap-12 px-5 py-20 sm:px-8 lg:grid-cols-[0.82fr_1.18fr] lg:py-28">
            <div className="lg:sticky lg:top-28 lg:self-start">
              <span className="flex h-11 w-11 items-center justify-center rounded-full border border-brand-300 text-brand-700"><Icon name="shield" size={20} /></span>
              <h2 className="landing-display mt-7 max-w-[570px] text-[clamp(2.7rem,4.4vw,4.4rem)] leading-[0.96] text-ink-950">
                Crescer sem abrir mão do controle.
              </h2>
              <p className="mt-6 max-w-[540px] text-base leading-7 text-stone-600">
                Empresas, perfis e responsabilidades permanecem separados enquanto a operação evolui.
              </p>
            </div>
            <dl className="border-t border-paper-400">
              {seguranca.map(([title, text]) => (
                <div key={title} className="grid gap-3 border-b border-paper-400 py-6 sm:grid-cols-[190px_1fr]">
                  <dt className="font-bold text-ink-950">{title}</dt>
                  <dd className="text-sm leading-6 text-stone-600">{text}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section id="demonstracao" className="bg-[#071A15] text-[#F2F7F5]">
          <div className="mx-auto grid max-w-[1240px] gap-12 px-5 py-20 sm:px-8 lg:grid-cols-[0.9fr_1.1fr] lg:gap-20 lg:py-28">
            <div>
              <h2 className="landing-display max-w-[650px] text-[clamp(2.8rem,5vw,5rem)] leading-[0.94]">
                Sua operação pode começar organizada.
              </h2>
              <p className="mt-6 max-w-[520px] text-base leading-7 text-[#A9BBB5]">
                Conte um pouco sobre sua empresa. Abriremos seu aplicativo de e-mail com a solicitação pronta.
              </p>
              <p className="mt-10 text-sm text-[#A9BBB5]">
                Já usa o Olume Chat?{' '}
                <Link to="/login" className="font-bold text-[#F2F7F5] underline decoration-[#5BD6AE] underline-offset-4">
                  Entrar no sistema
                </Link>
              </p>
            </div>

            <form onSubmit={solicitarDemonstracao} className="grid gap-5 border-t border-[#2D403A] pt-7 sm:grid-cols-2">
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-[#D8E5E1]">Seu nome</span>
                <input required value={form.nome} onChange={atualizar('nome')} autoComplete="name" className="landing-dark-input" placeholder="Como podemos chamar você?" />
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-[#D8E5E1]">Empresa</span>
                <input required value={form.empresa} onChange={atualizar('empresa')} autoComplete="organization" className="landing-dark-input" placeholder="Nome da empresa" />
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-[#D8E5E1]">E-mail de trabalho</span>
                <input required type="email" value={form.email} onChange={atualizar('email')} autoComplete="email" className="landing-dark-input" placeholder="voce@empresa.com" />
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-[#D8E5E1]">Pessoas no atendimento</span>
                <select required value={form.equipe} onChange={atualizar('equipe')} className="landing-dark-input">
                  <option value="" disabled>Selecione</option>
                  <option>1 a 5 pessoas</option>
                  <option>6 a 20 pessoas</option>
                  <option>21 a 50 pessoas</option>
                  <option>Mais de 50 pessoas</option>
                </select>
              </label>
              <div className="sm:col-span-2">
                <button type="submit" className="landing-mint-action inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-[#5BD6AE] px-6 text-sm font-bold text-[#071A15] hover:bg-[#7BE0C2] sm:w-auto">
                  Solicitar demonstração <span className="ml-3" aria-hidden="true">→</span>
                </button>
                <p className="mt-4 text-xs leading-5 text-[#A9BBB5]">
                  Ou escreva para <a className="text-[#F2F7F5] underline underline-offset-4 hover:text-[#5BD6AE]" href={`mailto:${emailComercial}`}>{emailComercial}</a>
                </p>
              </div>
            </form>
          </div>
        </section>
      </main>

      <footer className="border-t border-paper-300 bg-paper-50">
        <div className="mx-auto flex max-w-[1240px] flex-col gap-8 px-5 py-10 sm:px-8 md:flex-row md:items-end md:justify-between">
          <div>
            <Brand />
            <p className="mt-4 max-w-[390px] text-xs leading-5 text-stone-500">WhatsApp, filas, automações e gestão no mesmo contexto.</p>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-3 text-xs font-bold text-stone-600">
            <a href="#recursos" className="hover:text-ink-950">Recursos</a>
            <a href="#seguranca" className="hover:text-ink-950">Segurança</a>
            <Link to="/login" className="hover:text-ink-950">Já sou cliente</Link>
            <Link to="/operador/login" className="hover:text-ink-950">Acesso do operador</Link>
          </div>
        </div>
        <div className="border-t border-paper-300">
          <div className="mx-auto flex max-w-[1240px] gap-3 px-5 py-6 sm:px-8">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-brand-300 text-brand-700">
              <Icon name="shield" size={15} />
            </span>
            <div>
              <p className="text-xs font-bold text-ink-950">Tecnologia oficial WhatsApp Business</p>
              <p className="mt-1 max-w-[640px] text-xs leading-5 text-stone-500">
                A Olume atua como parceira de tecnologia da Meta: todo o atendimento roda pela API oficial
                do WhatsApp Business (Cloud API), sem atalhos por fora dela. Para usar a plataforma, sua
                empresa precisa de uma conta Meta Business ativa.
              </p>
            </div>
          </div>
        </div>
        <div className="border-t border-paper-300">
          <div className="mx-auto flex max-w-[1240px] flex-col gap-2 px-5 py-5 text-[11px] text-stone-500 sm:px-8 md:flex-row md:justify-between">
            <span>© {new Date().getFullYear()} Olume Software</span>
            <span>Simples. Humano. Contextual.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
