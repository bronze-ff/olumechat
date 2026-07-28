import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import Brand from '../components/ui/Brand';
import Icon from '../components/ui/Icon';
import ThemeMenu from '../components/ui/ThemeMenu';

function IconEye({ off }) {
  return off ? (
    <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M3 3l18 18M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 5.1A10.4 10.4 0 0 1 12 5c4.5 0 8.3 2.9 9.5 7a10 10 0 0 1-2 3.5M6.5 6.5A10.1 10.1 0 0 0 2.5 12c1.3 4.1 5 7 9.5 7 1.1 0 2.2-.2 3.2-.5" />
    </svg>
  ) : (
    <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M2.5 12c1.3-4.1 5-7 9.5-7s8.3 2.9 9.5 7c-1.3 4.1-5 7-9.5 7s-8.3-2.9-9.5-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function ProductPreview() {
  return (
    <div className="mt-auto pt-12">
      <div className="rounded-xl overflow-hidden border border-white/10 bg-white/[0.04]">
        <div className="h-10 px-3 flex items-center gap-2 border-b border-white/10">
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
          <span className="text-[11px] text-white/55">Operação ao vivo</span>
          <span className="ml-auto text-[10px] text-white/65">agora</span>
        </div>
        <div className="grid grid-cols-[118px_1fr] min-h-44">
          <div className="border-r border-white/10 p-2 space-y-1.5">
            {['Aguardando  3', 'Minhas  7', 'Automações  2'].map((item, index) => (
              <div key={item} className={`px-2 py-2 rounded-md text-[10px] ${index === 0 ? 'bg-white/10 text-white' : 'text-white/65'}`}>{item}</div>
            ))}
          </div>
          <div className="p-4">
            <div className="flex items-center gap-2">
              <span className="w-7 h-7 rounded-lg bg-brand-700 text-white flex items-center justify-center text-[10px]">AM</span>
              <div>
                <p className="text-[11px] font-medium text-white/85">Ana Martins</p>
                <p className="text-[9px] text-white/65">Atendimento · WhatsApp</p>
              </div>
            </div>
            <div className="mt-5 ml-auto max-w-[170px] rounded-lg rounded-br-sm bg-brand-700 px-3 py-2 text-[10px] leading-relaxed text-white">
              Olá, Ana! Já encontrei seu atendimento. Como posso ajudar?
            </div>
            <div className="mt-2 max-w-[150px] rounded-lg rounded-bl-sm bg-white/10 px-3 py-2 text-[10px] leading-relaxed text-white/65">
              Preciso atualizar meus dados.
            </div>
          </div>
        </div>
      </div>
      <p className="mt-4 text-xs text-white/65">Conversas, equipes e automações em um único fluxo de trabalho.</p>
    </div>
  );
}

export default function Login() {
  const { login } = useAuth();
  const [form, setForm] = useState({ empresa: localStorage.getItem('empresa') || '', email: '', senha: '' });
  const [showSenha, setShowSenha] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    if (!form.empresa || !form.email || !form.senha) {
      setError('Preencha empresa, e-mail e senha para continuar.');
      return;
    }
    setLoading(true);
    try {
      await login(form.empresa.trim().toLowerCase(), form.email.trim().toLowerCase(), form.senha);
    } catch (err) {
      setError(err.response?.data?.error || err.response?.data?.errors?.[0]?.msg || 'Não foi possível entrar. Confira os dados e tente novamente.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="relative min-h-screen bg-white lg:grid lg:grid-cols-[minmax(360px,0.78fr)_1.22fr]">
      <div className="absolute top-4 right-4 z-20"><ThemeMenu /></div>
      <section className="hidden lg:flex min-h-screen bg-ink-950 text-white p-9 xl:p-12 flex-col">
        <Brand inverse />
        <div className="mt-16 max-w-md">
          <h1 className="text-[34px] xl:text-[40px] leading-[1.12] tracking-[-0.035em] font-semibold text-balance">
            Atendimento organizado para equipes que não podem perder conversas.
          </h1>
          <p className="mt-5 text-[15px] leading-relaxed text-white/55 max-w-[52ch]">
            Entre no workspace da sua empresa para atender, acompanhar filas e manter cada cliente no contexto certo.
          </p>
        </div>
        <ProductPreview />
      </section>

      <section className="min-h-screen flex items-center justify-center px-5 py-10 sm:px-8">
        <div className="w-full max-w-[420px] animate-slide-up">
          <div className="lg:hidden mb-10"><Brand /></div>
          <div>
            <p className="text-sm font-medium text-brand-700">Acesso ao workspace</p>
            <h2 className="mt-2 text-[28px] font-semibold tracking-[-0.03em] text-ink-950">Bem-vindo de volta</h2>
            <p className="mt-2 text-sm text-stone-600">Use os dados fornecidos pelo administrador da sua empresa.</p>
          </div>

          <form onSubmit={handleSubmit} noValidate className="mt-8 space-y-5">
            <div>
              <label htmlFor="empresa" className="field-label">Identificador da empresa</label>
              <input id="empresa" type="text" value={form.empresa} onChange={set('empresa')} autoComplete="organization" autoCapitalize="none" spellCheck="false" placeholder="sua-empresa" className="input-field font-mono" />
              <p className="mt-1.5 text-xs text-stone-500">É o endereço curto informado no seu convite de acesso.</p>
            </div>
            <div>
              <label htmlFor="email" className="field-label">E-mail</label>
              <input id="email" type="email" value={form.email} onChange={set('email')} autoComplete="username" autoCapitalize="none" spellCheck="false" placeholder="voce@suaempresa.com.br" className="input-field" />
            </div>
            <div>
              <label htmlFor="senha" className="field-label">Senha</label>
              <div className="relative">
                <input id="senha" type={showSenha ? 'text' : 'password'} value={form.senha} onChange={set('senha')} autoComplete="current-password" placeholder="Digite sua senha" className="input-field pr-12" />
                <button type="button" onClick={() => setShowSenha((value) => !value)} className="absolute right-1 top-1 w-9 h-9 rounded-md flex items-center justify-center text-stone-500 hover:bg-paper-200 hover:text-ink-950" aria-label={showSenha ? 'Ocultar senha' : 'Mostrar senha'}>
                  <IconEye off={showSenha} />
                </button>
              </div>
            </div>

            {error && (
              <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800 flex gap-2" role="alert">
                <Icon name="alert" size={17} className="shrink-0 mt-0.5" />
                {error}
              </div>
            )}

            <button type="submit" disabled={loading} className="w-full min-h-11 px-5 rounded-lg bg-brand-700 hover:bg-brand-800 text-white text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2">
              {loading ? (
                <span className="w-4 h-4 rounded-full border-2 border-white/35 border-t-white animate-spin" />
              ) : null}
              {loading ? 'Entrando…' : 'Entrar no workspace'}
              {!loading && <Icon name="arrow" size={16} />}
            </button>
          </form>

          <div className="mt-7 pt-5 border-t border-paper-300">
            <p className="text-xs leading-relaxed text-stone-600">
              Primeiro acesso? Abra o convite enviado pelo administrador para criar sua senha. O link funciona uma única vez.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
