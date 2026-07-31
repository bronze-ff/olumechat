import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import Brand, { BrandMark } from '../components/ui/Brand';
import Icon from '../components/ui/Icon';
import ThemeMenu from '../components/ui/ThemeMenu';

const caminho = [
  {
    titulo: 'Chega pelo canal oficial',
    texto: 'A mensagem entra no Olume Chat e já aparece para a operação.',
  },
  {
    titulo: 'Encontra a fila certa',
    texto: 'Regras e departamentos deixam claro quem pode assumir.',
  },
  {
    titulo: 'Segue com contexto',
    texto: 'Equipe e IA atendem sem fazer o cliente começar de novo.',
  },
  {
    titulo: 'Continua visível',
    texto: 'Histórico, transferência e andamento ficam no mesmo lugar.',
  },
];

const controles = [
  ['Canal oficial', 'Conexão direta com a Cloud API da Meta.'],
  ['Empresas isoladas', 'Cada operação permanece em seu próprio contexto.'],
  ['Acesso por perfil', 'Cada pessoa vê e faz apenas o que precisa.'],
  ['Ações rastreáveis', 'Atendimentos e acessos de suporte deixam histórico.'],
];

const emailComercial = import.meta.env.VITE_COMERCIAL_EMAIL || 'comercial@olumechat.com.br';
// Axios cru, sem o interceptor de sessão de services/api.js: este endpoint é
// público (FIL-96) e aquele client redireciona pra /login quando não há
// token — o que derrubaria toda submissão vinda da landing.
const API_URL = import.meta.env.VITE_API_URL || '/api';

function ProductPreview() {
  const [etapa, setEtapa] = useState(0);
  const temporizadores = useRef([]);

  useEffect(() => {
    const reduzirMovimento = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduzirMovimento) {
      setEtapa(2);
      return undefined;
    }

    temporizadores.current = [
      window.setTimeout(() => setEtapa(1), 1300),
      window.setTimeout(() => setEtapa(2), 2700),
    ];
    return () => {
      temporizadores.current.forEach((temporizador) => window.clearTimeout(temporizador));
      temporizadores.current = [];
    };
  }, []);

  function selecionarEtapa(index) {
    temporizadores.current.forEach((temporizador) => window.clearTimeout(temporizador));
    temporizadores.current = [];
    setEtapa(index);
  }

  const estados = [
    {
      titulo: 'Mensagem recebida',
      detalhe: 'Aguardando direcionamento',
      status: 'Nova',
    },
    {
      titulo: 'Fila comercial',
      detalhe: 'Disponível para a equipe',
      status: 'Na fila',
    },
    {
      titulo: 'Atendimento assumido',
      detalhe: 'Contexto preservado',
      status: 'Em atendimento',
    },
  ];

  return (
    <figure className="landing-product-wrap landing-enter landing-enter-delay">
      <div
        className="landing-product-frame"
        role="group"
        aria-label="Demonstração interativa do caminho de uma conversa no Olume Chat"
      >
        <div className="landing-product-topbar">
          <div className="flex items-center gap-2">
            <span className="landing-mini-mark" aria-hidden="true">
              <BrandMark inverse className="h-4 w-4" />
            </span>
            <strong>Conversas</strong>
          </div>
          <span className="landing-preview-online">
            <i aria-hidden="true" />
            Operação online
          </span>
        </div>

        <div className="landing-preview-grid">
          <div className="landing-preview-queue">
            <p className="landing-preview-label">Caminho da conversa</p>
            <ol>
              {estados.map((estado, index) => (
                <li key={estado.titulo} className={index === etapa ? 'is-current' : index < etapa ? 'is-done' : ''}>
                  <button type="button" onClick={() => selecionarEtapa(index)} aria-pressed={etapa === index}>
                    <span className="landing-preview-step" aria-hidden="true">
                      {index < etapa ? <Icon name="check" size={11} /> : index + 1}
                    </span>
                    <span>
                      <strong>{estado.titulo}</strong>
                      <small>{estado.detalhe}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </div>

          <div className="landing-preview-thread">
            <div className="landing-preview-thread-head">
              <span className="landing-preview-avatar" aria-hidden="true">
                <Icon name="contact" size={14} />
              </span>
              <span>
                <strong>Cliente</strong>
                <small>WhatsApp · {estados[etapa].status}</small>
              </span>
              <span className="landing-preview-state" aria-live="polite">{estados[etapa].status}</span>
            </div>
            <div className="landing-preview-messages">
              <div className="landing-preview-message is-customer">
                Preciso ajustar a entrega do meu pedido.
              </div>
              <div className="landing-preview-event">
                {etapa === 0 && 'A conversa entrou na operação.'}
                {etapa === 1 && 'Direcionada para a fila comercial.'}
                {etapa === 2 && 'Atendimento assumido com o histórico completo.'}
              </div>
              <div className={`landing-preview-message is-team ${etapa === 2 ? 'is-visible' : ''}`}>
                Já tenho o contexto. Vamos ajustar a entrega.
              </div>
            </div>
            <div className="landing-preview-composer">
              <span className="landing-preview-compose-copy">
                {etapa === 2 ? 'Responder com contexto…' : 'Disponível quando o atendimento for assumido'}
              </span>
              <span className={`landing-preview-send ${etapa === 2 ? 'is-ready' : ''}`} aria-hidden="true">
                <Icon name="arrow" size={13} />
              </span>
            </div>
          </div>

          <aside className="landing-preview-context" aria-label="Contexto preservado na conversa">
            <div>
              <p className="landing-preview-label">Contexto</p>
              <strong>Entrega do pedido</strong>
            </div>
            <dl>
              <div>
                <dt>Origem</dt>
                <dd>WhatsApp oficial</dd>
              </div>
              <div>
                <dt>Fila</dt>
                <dd>{etapa === 0 ? 'A definir' : 'Comercial'}</dd>
              </div>
              <div>
                <dt>Responsável</dt>
                <dd>{etapa === 2 ? 'Equipe' : 'Aguardando'}</dd>
              </div>
            </dl>
            <p className="landing-preview-note">
              O histórico acompanha cada mudança de responsável.
            </p>
          </aside>
        </div>
      </div>
      <figcaption>
        Uma mensagem chegando, encontrando a fila e seguindo com contexto.
      </figcaption>
    </figure>
  );
}

function JourneyStory() {
  return (
    <ol className="landing-journey">
      {caminho.map((item, index) => (
        <li key={item.titulo}>
          <span aria-hidden="true">{index + 1}</span>
          <div>
            <h3>{item.titulo}</h3>
            <p>{item.texto}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function Landing() {
  const [form, setForm] = useState({ nome: '', empresa: '', email: '', equipe: '', site: '' });
  const [envio, setEnvio] = useState({ estado: 'idle', erro: '' }); // idle | enviando | sucesso | erro

  function atualizar(campo) {
    return (event) => setForm((atual) => ({ ...atual, [campo]: event.target.value }));
  }

  function abrirMailto() {
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

  async function solicitarDemonstracao(event) {
    event.preventDefault();
    setEnvio({ estado: 'enviando', erro: '' });
    try {
      await axios.post(`${API_URL}/leads`, {
        nome: form.nome,
        empresa: form.empresa,
        email: form.email,
        tamanhoEquipe: form.equipe,
        origem: window.location.search || undefined,
        site: form.site, // honeypot — sempre vazio para uma pessoa
      });
      setEnvio({ estado: 'sucesso', erro: '' });
    } catch (err) {
      if (!err.response) {
        // Sem resposta do servidor (rede caiu, DNS, etc.) — nunca perde o
        // interessado: cai no mailto, que já funcionava antes deste ticket.
        abrirMailto();
        setEnvio({ estado: 'mailto', erro: '' });
        return;
      }
      setEnvio({ estado: 'erro', erro: err.response?.data?.error || 'Não foi possível enviar agora. Tente novamente ou escreva para nosso e-mail.' });
    }
  }

  return (
    <div className="landing-page min-h-screen bg-paper-50 text-stone-900">
      <a href="#conteudo" className="sr-only z-[100] rounded-md bg-white px-4 py-3 text-sm font-semibold text-ink-950 focus:not-sr-only focus:fixed focus:left-4 focus:top-4">
        Ir para o conteúdo
      </a>

      <header className="landing-nav-wrap sticky top-0 z-50 px-3 pt-3 sm:px-5">
        <div className="landing-nav mx-auto flex h-[58px] max-w-[1240px] items-center gap-4 rounded-full bg-[#071A15] px-3.5 text-white sm:px-5">
          <Link to="/" aria-label="Olume Chat, página inicial" className="shrink-0 rounded-md">
            <Brand inverse compact className="sm:hidden" />
            <Brand inverse className="hidden sm:flex" />
          </Link>
          <nav aria-label="Navegação principal" className="mx-auto hidden items-center gap-7 text-[13px] font-medium text-white/75 lg:flex">
            <a href="#produto" className="hover:text-white">Produto</a>
            <a href="#como-funciona" className="hover:text-white">Como funciona</a>
            <a href="#controle" className="hover:text-white">Controle</a>
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
                <a href="#como-funciona" className="landing-cta inline-flex min-h-12 items-center justify-center rounded-xl border border-ink-950 bg-transparent px-6 text-sm font-bold text-ink-950 hover:bg-ink-950 hover:text-white">
                  Ver a plataforma
                </a>
              </div>
            </div>

            <ProductPreview />
          </div>

          <div className="landing-proof-strip mx-auto max-w-[1240px] border-t border-paper-300 px-5 sm:px-8">
            {[
              ['Cloud API oficial', 'Sem atalhos pelo WhatsApp Web'],
              ['Controle por perfil', 'Acesso conforme a responsabilidade'],
              ['Operação auditável', 'Ações e suporte deixam histórico'],
            ].map(([title, text]) => (
              <div key={title}>
                <strong>{title}</strong>
                <span>{text}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="landing-pain-section">
          <div className="mx-auto max-w-[1240px] px-5 py-20 sm:px-8 lg:py-28">
            <h2 className="landing-display max-w-[980px] text-[clamp(2.6rem,5vw,4.8rem)] leading-[0.94]">
              Quando ninguém vê o caminho, a conversa se perde.
            </h2>
            <div className="landing-pain-story">
              <span>Uma mensagem chega.</span>
              <span>Ninguém assume.</span>
              <span>O cliente conta tudo outra vez.</span>
            </div>
            <p className="landing-resolution">
              O Olume Chat mostra onde cada conversa está — e o que precisa acontecer depois.
            </p>
          </div>
        </section>

        <section id="como-funciona" className="border-b border-paper-300">
          <div className="mx-auto max-w-[1240px] px-5 py-20 sm:px-8 lg:py-28">
            <div className="landing-section-intro">
              <h2 className="landing-display text-[clamp(2.7rem,4.6vw,4.6rem)] leading-[0.96] text-ink-950">
                A conversa sabe para onde ir.
              </h2>
              <p>
                Automação entra onde ajuda. Gente entra quando precisa. O contexto segue junto.
              </p>
            </div>
            <JourneyStory />
          </div>
        </section>

        <section id="controle" className="landing-control-section">
          <div className="mx-auto grid max-w-[1240px] gap-12 px-5 py-20 sm:px-8 lg:grid-cols-[0.88fr_1.12fr] lg:py-28">
            <div className="lg:sticky lg:top-28 lg:self-start">
              <span className="landing-control-icon" aria-hidden="true"><Icon name="shield" size={20} /></span>
              <h2 className="landing-display mt-7 max-w-[590px] text-[clamp(2.7rem,4.4vw,4.4rem)] leading-[0.96] text-ink-950">
                Crescer sem perder o controle.
              </h2>
            </div>
            <dl className="landing-control-list">
              {controles.map(([title, text]) => (
                <div key={title}>
                  <dt>{title}</dt>
                  <dd>{text}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section id="demonstracao" className="landing-demo-section">
          <div className="mx-auto grid max-w-[1240px] gap-12 px-5 py-20 sm:px-8 lg:grid-cols-[0.88fr_1.12fr] lg:gap-20 lg:py-28">
            <div>
              <h2 className="landing-display max-w-[650px] text-[clamp(2.8rem,5vw,5rem)] leading-[0.94]">
                Vamos olhar sua operação juntos.
              </h2>
              <p className="mt-6 max-w-[500px] text-base leading-7 text-[#BFD0CA]">
                Conte como sua equipe atende hoje. A demonstração parte da sua rotina.
              </p>
              <p className="mt-10 text-sm text-[#BFD0CA]">
                Já usa o Olume Chat?{' '}
                <Link to="/login" className="font-bold text-[#F3F8F6] underline decoration-[#5BD6AE] underline-offset-4">
                  Entrar no sistema
                </Link>
              </p>
            </div>

            {envio.estado === 'sucesso' || envio.estado === 'mailto' ? (
              <div className="border-t border-[#4D625C]/50 pt-7" role="status">
                <div className="landing-demo-success">
                  <span aria-hidden="true"><Icon name="check" size={18} /></span>
                  <div>
                    <p className="font-bold text-[#F3F8F6]">
                      {envio.estado === 'sucesso' ? 'Recebemos!' : 'Abrimos seu e-mail.'}
                    </p>
                    <p className="mt-1 text-sm leading-6 text-[#BFD0CA]">
                      {envio.estado === 'sucesso'
                        ? 'Nosso time comercial vai entrar em contato.'
                        : 'Não conseguimos enviar automaticamente agora, então preparamos a mensagem no seu aplicativo de e-mail — é só confirmar o envio.'}
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <form onSubmit={solicitarDemonstracao} className="grid gap-5 border-t border-[#4D625C]/50 pt-7 sm:grid-cols-2">
                {/* Honeypot: campo que só um bot preenche (humano não vê nem tabula
                    até ele). Vindo preenchido, o backend descarta em silêncio. */}
                <label className="absolute h-0 w-0 overflow-hidden opacity-0" aria-hidden="true" tabIndex={-1}>
                  Não preencha este campo
                  <input type="text" name="site" tabIndex={-1} autoComplete="off" value={form.site} onChange={atualizar('site')} />
                </label>
                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-[#E9EFEA]">Seu nome</span>
                  <input required value={form.nome} onChange={atualizar('nome')} autoComplete="name" className="landing-dark-input" placeholder="Como podemos chamar você?" />
                </label>
                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-[#E9EFEA]">Empresa</span>
                  <input required value={form.empresa} onChange={atualizar('empresa')} autoComplete="organization" className="landing-dark-input" placeholder="Nome da empresa" />
                </label>
                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-[#E9EFEA]">E-mail de trabalho</span>
                  <input required type="email" value={form.email} onChange={atualizar('email')} autoComplete="email" className="landing-dark-input" placeholder="voce@empresa.com" />
                </label>
                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-[#E9EFEA]">Pessoas no atendimento</span>
                  <select required value={form.equipe} onChange={atualizar('equipe')} className="landing-dark-input">
                    <option value="" disabled>Selecione</option>
                    <option>1 a 5 pessoas</option>
                    <option>6 a 20 pessoas</option>
                    <option>21 a 50 pessoas</option>
                    <option>Mais de 50 pessoas</option>
                  </select>
                </label>
                <div className="sm:col-span-2">
                  <button
                    type="submit"
                    disabled={envio.estado === 'enviando'}
                    className="landing-mint-action inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-[#5BD6AE] px-6 text-sm font-bold text-[#071A15] hover:bg-[#7BE0C2] disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
                  >
                    {envio.estado === 'enviando' ? 'Enviando…' : 'Solicitar demonstração'}
                    {envio.estado !== 'enviando' && <span className="ml-3" aria-hidden="true">→</span>}
                  </button>
                  {envio.estado === 'erro' && (
                    <p className="mt-3 text-xs leading-5 text-[#FFB4A9]" role="alert">{envio.erro}</p>
                  )}
                  <p className="mt-4 text-xs leading-5 text-[#BFD0CA]">
                    Ou escreva para <a className="text-[#F3F8F6] underline underline-offset-4 hover:text-[#5BD6AE]" href={`mailto:${emailComercial}`}>{emailComercial}</a>
                  </p>
                </div>
              </form>
            )}
          </div>
        </section>
      </main>

      <footer className="border-t border-paper-300 bg-paper-50">
        <div className="mx-auto flex max-w-[1240px] flex-col gap-8 px-5 py-10 sm:px-8 md:flex-row md:items-end md:justify-between">
          <div>
            <Brand />
            <p className="mt-4 max-w-[390px] text-xs leading-5 text-stone-500">
              Cada conversa com um caminho visível.
            </p>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-3 text-xs font-bold text-stone-600">
            <a href="#como-funciona" className="hover:text-ink-950">Como funciona</a>
            <a href="#controle" className="hover:text-ink-950">Controle</a>
            <Link to="/login" className="hover:text-ink-950">Já sou cliente</Link>
            <Link to="/operador/login" className="hover:text-ink-950">Acesso do operador</Link>
          </div>
        </div>
        <div className="border-t border-paper-300">
          <div className="mx-auto flex max-w-[1240px] gap-3 px-5 py-6 sm:px-8">
            <span className="landing-footer-shield" aria-hidden="true"><Icon name="shield" size={15} /></span>
            <p className="max-w-[720px] text-xs leading-5 text-stone-500">
              O atendimento roda pela Cloud API oficial do WhatsApp Business, sem atalhos pelo WhatsApp Web.
              A empresa precisa de uma conta Meta Business ativa.
            </p>
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
