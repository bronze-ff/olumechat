// Primeiro acesso (FIL-67): o administrador cadastra o usuário e manda um
// link /definir-senha?empresa=<slug>&token=<token>. O token vale UMA vez e
// expira — o backend confere isso; aqui a tela só reage ao veredito dele.
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../services/api';

const BORDEAUX = '#9B1B1B';
const MIN_PADRAO = 10;

function MiniSpinner() {
  return (
    <span className="inline-block w-4 h-4 rounded-full border-2 animate-spin"
      style={{ borderColor: 'rgba(255,255,255,0.4)', borderTopColor: '#fff' }} />
  );
}

export default function DefinirSenha() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const empresa = (params.get('empresa') || '').trim().toLowerCase();
  const token = params.get('token') || '';

  const [checando, setChecando] = useState(true);
  const [dono, setDono] = useState(null);      // { nome, email } | null
  const [minimo, setMinimo] = useState(MIN_PADRAO);
  const [form, setForm] = useState({ senha: '', repetir: '' });
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const [pronto, setPronto] = useState(false);

  const set = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }));

  // Confere o link ANTES de o usuário digitar: nada pior que escolher a senha
  // e só então descobrir que o link venceu. Esta chamada não consome o token.
  useEffect(() => {
    if (!empresa || !token) { setErro('Link incompleto.'); setChecando(false); return; }
    api.get('/auth/definir-senha', { params: { empresa, token } })
      .then(({ data }) => { setDono({ nome: data.nome, email: data.email }); setMinimo(data.minimo || MIN_PADRAO); })
      .catch((e) => setErro(e.response?.data?.error || 'Link inválido ou expirado.'))
      .finally(() => setChecando(false));
  }, [empresa, token]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErro('');
    if (form.senha !== form.repetir) { setErro('As duas senhas não são iguais.'); return; }
    if (form.senha.length < minimo) { setErro(`A senha precisa ter pelo menos ${minimo} caracteres.`); return; }
    setSalvando(true);
    try {
      await api.post('/auth/definir-senha', { empresa, token, senha: form.senha });
      setPronto(true);
      localStorage.setItem('empresa', empresa);
    } catch (err) {
      setErro(err.response?.data?.error || 'Não foi possível definir a senha. Peça um link novo.');
    } finally {
      setSalvando(false);
    }
  };

  return (
    <div className="min-h-screen bg-white flex items-center justify-center px-6 py-12 relative overflow-hidden">
      <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ opacity: 0.12 }} xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern id="system-grid-senha" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1B5E7B" strokeWidth="0.7" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#system-grid-senha)" />
      </svg>

      <div className="w-full max-w-sm animate-slide-up relative">
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-4">
            <span className="rounded-full shrink-0" style={{ width: 4, height: 16, background: BORDEAUX }} />
            <span className="font-mono text-[10px] uppercase tracking-widest text-stone-400">Primeiro acesso</span>
          </div>
          <h2 className="font-display text-2xl font-bold" style={{ color: '#1A5276' }}>Defina sua senha</h2>
          {dono && (
            <p className="text-sm text-stone-500 mt-1">
              {dono.nome ? `${dono.nome} — ` : ''}<span className="font-mono">{dono.email}</span>
            </p>
          )}
        </div>

        {checando && <p className="text-sm text-stone-500">Conferindo o link…</p>}

        {!checando && pronto && (
          <div className="space-y-5">
            <div className="p-3 bg-green-50 border border-green-200 rounded text-sm text-green-800">
              Senha definida. Já dá para entrar.
            </div>
            <button type="button" onClick={() => navigate('/login', { replace: true })}
              className="w-full py-3 text-sm font-medium text-white"
              style={{ background: BORDEAUX, borderRadius: 4 }}>
              Ir para o login
            </button>
          </div>
        )}

        {!checando && !pronto && !dono && (
          <div className="space-y-5">
            <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{erro}</div>
            <p className="text-xs text-stone-500">
              Links de primeiro acesso valem uma vez só e expiram. Peça um novo ao
              administrador da sua empresa.
            </p>
          </div>
        )}

        {!checando && !pronto && dono && (
          <form onSubmit={handleSubmit} noValidate className="space-y-5">
            <div>
              <label htmlFor="senha" className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Nova senha</label>
              <input id="senha" type="password" value={form.senha} onChange={set('senha')}
                autoComplete="new-password" placeholder="••••••••" className="input-field font-mono" />
              <p className="mt-1.5 text-xs text-stone-500">Pelo menos {minimo} caracteres.</p>
            </div>
            <div>
              <label htmlFor="repetir" className="block text-xs font-semibold uppercase tracking-wide text-stone-600 mb-1.5">Repita a senha</label>
              <input id="repetir" type="password" value={form.repetir} onChange={set('repetir')}
                autoComplete="new-password" placeholder="••••••••" className="input-field font-mono" />
            </div>

            {erro && <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{erro}</div>}

            <button type="submit" disabled={salvando}
              className="w-full flex items-center justify-center gap-2 py-3 text-sm font-medium text-white disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: BORDEAUX, borderRadius: 4 }}>
              {salvando ? <MiniSpinner /> : null}
              Salvar senha
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
