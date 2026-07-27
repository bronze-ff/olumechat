import { useState } from 'react';
import { useAuth } from '../context/AuthContext';

const NAVY_GRAD = 'linear-gradient(160deg, #1B5E7B 0%, #1A5276 100%)';
const BORDEAUX = '#9B1B1B';

const features = [
  { label: 'Inbox unificado', desc: 'Todas as conversas num lugar' },
  { label: 'Multi-número', desc: 'Vários números, um painel' },
  { label: 'Histórico completo', desc: 'Conversas e mídias salvas' },
  { label: 'API oficial Meta', desc: 'Sem bloqueio de chip' },
];

function IconEye({ off }) {
  return off ? (
    <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
    </svg>
  ) : (
    <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
    </svg>
  );
}
function IconArrow() {
  return (
    <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}
function MiniSpinner() {
  return (
    <span className="inline-block w-4 h-4 rounded-full border-2 animate-spin"
      style={{ borderColor: 'rgba(255,255,255,0.4)', borderTopColor: '#fff' }} />
  );
}

export default function Login() {
  const { login } = useAuth();
  // A empresa (slug do tenant) fica lembrada entre acessos: o usuário digita
  // o mesmo valor todo dia, e ela não é segredo — sozinha não abre nada.
  const [form, setForm] = useState({ empresa: localStorage.getItem('empresa') || '', email: '', senha: '' });
  const [showSenha, setShowSenha] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [btnHover, setBtnHover] = useState(false);

  const set = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!form.empresa || !form.email || !form.senha) { setError('Preencha todos os campos'); return; }
    setLoading(true);
    try {
      await login(form.empresa.trim().toLowerCase(), form.email.trim().toLowerCase(), form.senha);
    } catch (err) {
      setError(
        err.response?.data?.error ||
        err.response?.data?.errors?.[0]?.msg ||
        'Credenciais inválidas. Tente novamente.'
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex">
      {/* Painel esquerdo navy */}
      <div className="left-panel relative hidden lg:flex flex-col p-12 overflow-hidden shrink-0"
        style={{ width: '420px', background: NAVY_GRAD }}>
        <style>{`@media (min-width: 1280px) { .left-panel { width: 480px !important; } }`}</style>
        <div className="absolute -bottom-20 -right-20 rounded-full pointer-events-none"
          style={{ width: 320, height: 320, background: BORDEAUX, opacity: 0.15 }} />
        <div className="absolute top-16 -right-10 rounded-full pointer-events-none"
          style={{ width: 160, height: 160, background: 'rgba(255,255,255,0.08)' }} />

        <div className="mb-12">
          <div className="mb-5 flex items-center gap-3">
            <div className="shrink-0" style={{ width: 4, height: 16, background: BORDEAUX }} />
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-white/50">Falatta</p>
          </div>
          <h1 className="font-display text-4xl font-bold leading-tight text-white">Atendimento WhatsApp</h1>
        </div>

        <p className="max-w-xs text-sm leading-relaxed pl-4 text-white/65" style={{ borderLeft: `2px solid ${BORDEAUX}` }}>
          Plataforma oficial de atendimento e cobrança via WhatsApp (API Meta).
          Conversas, histórico e múltiplos números num único painel.
        </p>

        <div className="mt-auto pt-10 grid grid-cols-2 gap-3">
          {features.map((f) => (
            <div key={f.label} className="p-3"
              style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4 }}>
              <p className="text-xs font-semibold text-white">{f.label}</p>
              <p className="mt-2 leading-relaxed" style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>{f.desc}</p>
            </div>
          ))}
        </div>
        <p className="font-mono uppercase text-white/40 mt-6" style={{ fontSize: 11, letterSpacing: '0.16em' }}>
          © {new Date().getFullYear()} Falatta
        </p>
      </div>

      {/* Painel direito form */}
      <div className="flex-1 bg-white flex items-center justify-center px-6 py-12 relative overflow-hidden">
        <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ opacity: 0.12 }} xmlns="http://www.w3.org/2000/svg">
          <defs>
            <pattern id="system-grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1B5E7B" strokeWidth="0.7" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#system-grid)" />
        </svg>

        <div className="w-full max-w-sm animate-slide-up relative">
          <div className="mb-8">
            <div className="flex items-center gap-2 mb-4">
              <span className="rounded-full shrink-0" style={{ width: 4, height: 16, background: BORDEAUX }} />
              <span className="font-mono text-[10px] uppercase tracking-widest text-stone-400">Acesso</span>
            </div>
            <h2 className="font-display text-2xl font-bold" style={{ color: '#1A5276' }}>Entrar no Atendimento</h2>
            <p className="text-sm text-stone-500 mt-1">Entre com o e-mail e a senha da sua conta.</p>
          </div>

          <form onSubmit={handleSubmit} noValidate className="space-y-5">
            <div>
              <label htmlFor="empresa" className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Empresa</label>
              <input id="empresa" type="text" value={form.empresa} onChange={set('empresa')}
                autoComplete="organization" autoCapitalize="none" spellCheck="false"
                placeholder="sua-empresa" className="input-field font-mono" />
            </div>
            <div>
              <label htmlFor="email" className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">E-mail</label>
              <input id="email" type="email" value={form.email} onChange={set('email')}
                autoComplete="username" autoCapitalize="none" spellCheck="false"
                placeholder="voce@suaempresa.com.br" className="input-field" />
            </div>
            <div>
              <label htmlFor="senha" className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Senha</label>
              <div className="relative">
                <input id="senha" type={showSenha ? 'text' : 'password'} value={form.senha} onChange={set('senha')}
                  autoComplete="current-password" placeholder="••••••••" className="input-field font-mono pr-11" />
                <button type="button" onClick={() => setShowSenha((s) => !s)}
                  className="absolute right-0 top-0 h-full px-3 flex items-center text-stone-400 hover:text-stone-600"
                  aria-label={showSenha ? 'Ocultar senha' : 'Mostrar senha'}>
                  <IconEye off={showSenha} />
                </button>
              </div>
            </div>

            {error && <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{error}</div>}

            <button type="submit" disabled={loading}
              onMouseEnter={() => setBtnHover(true)} onMouseLeave={() => setBtnHover(false)}
              className="w-full flex items-center justify-center gap-2 py-3 text-sm font-medium text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              style={{ background: btnHover ? '#8B1A1A' : BORDEAUX, borderRadius: 4 }}>
              {loading ? <MiniSpinner /> : null}
              Entrar
              {!loading && <IconArrow />}
            </button>
          </form>

          <p className="mt-6 text-xs leading-relaxed text-stone-500">
            Primeiro acesso? Use o link de definição de senha que o administrador
            da sua empresa enviou — ele vale uma vez só e expira.
          </p>
        </div>
      </div>
    </div>
  );
}
