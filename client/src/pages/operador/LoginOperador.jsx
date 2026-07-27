import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import apiOperador, { CHAVE_TOKEN } from '../../services/apiOperador';

// Login do painel do OPERADOR (FIL-70). Visualmente parecido com o do cliente,
// mas deliberadamente marcado como "área interna": quem chega aqui por engano
// tem que perceber na hora que não é a tela da empresa dele.
const NAVY_GRAD = 'linear-gradient(160deg, #0F2A3D 0%, #163B54 100%)';
const BORDEAUX = '#9B1B1B';

export default function LoginOperador() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', senha: '' });
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(false);

  const set = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }));

  async function entrar(e) {
    e.preventDefault();
    setErro('');
    if (!form.email || !form.senha) { setErro('Preencha e-mail e senha.'); return; }
    setCarregando(true);
    try {
      const { data } = await apiOperador.post('/login', {
        email: form.email.trim().toLowerCase(), senha: form.senha,
      });
      localStorage.setItem(CHAVE_TOKEN, data.token);
      navigate('/operador', { replace: true });
    } catch (err) {
      setErro(err.response?.data?.error || 'Não foi possível entrar. Tente novamente.');
    } finally {
      setCarregando(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6 py-12" style={{ background: NAVY_GRAD }}>
      <div className="w-full max-w-sm bg-white rounded-2xl p-8 animate-slide-up">
        <div className="flex items-center gap-2 mb-4">
          <span className="rounded-full shrink-0" style={{ width: 4, height: 16, background: BORDEAUX }} />
          <span className="font-mono text-[10px] uppercase tracking-widest text-stone-400">Área interna</span>
        </div>
        <h1 className="font-display text-2xl font-bold" style={{ color: '#1A5276' }}>Painel do operador</h1>
        <p className="text-sm text-stone-500 mt-1 mb-6">
          Provisionar e administrar os clientes do Falatta. Não é a entrada do painel da sua empresa.
        </p>

        <form onSubmit={entrar} noValidate className="space-y-5">
          <div>
            <label htmlFor="email" className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">E-mail</label>
            <input id="email" type="email" className="input-field" value={form.email} onChange={set('email')}
              autoComplete="username" autoCapitalize="none" spellCheck="false" placeholder="voce@falatta.com" />
          </div>
          <div>
            <label htmlFor="senha" className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Senha</label>
            <input id="senha" type="password" className="input-field font-mono" value={form.senha} onChange={set('senha')}
              autoComplete="current-password" placeholder="••••••••" />
          </div>

          {erro && <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{erro}</div>}

          <button type="submit" disabled={carregando}
            className="w-full py-3 text-sm font-medium text-white disabled:opacity-50"
            style={{ background: BORDEAUX, borderRadius: 4 }}>
            {carregando ? 'Entrando…' : 'Entrar'}
          </button>
        </form>

        <p className="mt-6 text-xs leading-relaxed text-stone-500">
          Conta de operador não tem auto-cadastro: ela nasce por
          <code className="font-mono text-[11px] mx-1">npm run criar-operador</code>
          no servidor.
        </p>
      </div>
    </div>
  );
}
