import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../services/api';
import Brand from '../components/ui/Brand';
import Icon from '../components/ui/Icon';
import ThemeMenu from '../components/ui/ThemeMenu';

const MIN_PADRAO = 10;

export default function DefinirSenha() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const empresa = (params.get('empresa') || '').trim().toLowerCase();
  const token = params.get('token') || '';
  const [checando, setChecando] = useState(true);
  const [dono, setDono] = useState(null);
  const [minimo, setMinimo] = useState(MIN_PADRAO);
  const [form, setForm] = useState({ senha: '', repetir: '' });
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const [pronto, setPronto] = useState(false);
  const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));

  useEffect(() => {
    if (!empresa || !token) {
      setErro('Este link está incompleto. Solicite um novo convite.');
      setChecando(false);
      return;
    }
    api.get('/auth/definir-senha', { params: { empresa, token } })
      .then(({ data }) => {
        setDono({ nome: data.nome, email: data.email });
        setMinimo(data.minimo || MIN_PADRAO);
      })
      .catch((error) => setErro(error.response?.data?.error || 'Este convite é inválido ou já expirou.'))
      .finally(() => setChecando(false));
  }, [empresa, token]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setErro('');
    if (form.senha !== form.repetir) {
      setErro('As senhas não são iguais. Digite novamente.');
      return;
    }
    if (form.senha.length < minimo) {
      setErro(`Use uma senha com pelo menos ${minimo} caracteres.`);
      return;
    }
    setSalvando(true);
    try {
      await api.post('/auth/definir-senha', { empresa, token, senha: form.senha });
      setPronto(true);
      localStorage.setItem('empresa', empresa);
    } catch (error) {
      setErro(error.response?.data?.error || 'Não foi possível criar a senha. Solicite um novo convite.');
    } finally {
      setSalvando(false);
    }
  };

  return (
    <main className="min-h-screen bg-paper-100">
      <header className="h-20 px-5 md:px-8 flex items-center justify-between bg-white border-b border-paper-300">
        <Brand />
        <ThemeMenu />
      </header>
      <div className="px-5 py-10 md:py-16 flex justify-center">
        <section className="w-full max-w-[460px] bg-white border border-paper-300 rounded-xl p-6 sm:p-8 animate-slide-up">
          <div className="w-10 h-10 rounded-xl bg-brand-100 text-brand-800 flex items-center justify-center">
            <Icon name={pronto ? 'check' : 'shield'} size={19} />
          </div>
          <p className="mt-5 text-sm font-medium text-brand-700">Primeiro acesso · {empresa || 'Falatta'}</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-[-0.025em] text-ink-950">
            {pronto ? 'Seu acesso está pronto' : 'Crie uma senha segura'}
          </h1>
          {dono && !pronto && (
            <p className="mt-2 text-sm text-stone-600">
              Convite para {dono.nome ? <strong>{dono.nome}</strong> : dono.email}
              {dono.nome ? <span className="block text-xs mt-0.5">{dono.email}</span> : null}
            </p>
          )}

          {checando && (
            <div className="mt-8 flex items-center gap-3 text-sm text-stone-600">
              <span className="w-4 h-4 rounded-full border-2 border-brand-200 border-t-brand-700 animate-spin" />
              Validando seu convite…
            </div>
          )}

          {!checando && pronto && (
            <div className="mt-7">
              <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-900">
                Senha criada com sucesso. Agora você pode entrar no workspace da sua empresa.
              </div>
              <button type="button" onClick={() => navigate('/login', { replace: true })} className="mt-5 w-full min-h-11 rounded-lg bg-brand-700 hover:bg-brand-800 text-white text-sm font-semibold inline-flex items-center justify-center gap-2">
                Ir para o acesso
                <Icon name="arrow" size={16} />
              </button>
            </div>
          )}

          {!checando && !pronto && !dono && (
            <div className="mt-7">
              <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800 flex gap-2">
                <Icon name="alert" size={18} className="shrink-0 mt-0.5" />
                {erro}
              </div>
              <p className="mt-4 text-xs leading-relaxed text-stone-600">
                Convites funcionam uma única vez e expiram por segurança. Fale com o administrador da empresa para receber outro.
              </p>
            </div>
          )}

          {!checando && !pronto && dono && (
            <form onSubmit={handleSubmit} noValidate className="mt-7 space-y-5">
              <div>
                <label htmlFor="senha" className="field-label">Nova senha</label>
                <input id="senha" type="password" value={form.senha} onChange={set('senha')} autoComplete="new-password" placeholder={`Pelo menos ${minimo} caracteres`} className="input-field" />
                <p className="mt-1.5 text-xs text-stone-500">Use uma combinação que você não utiliza em outros serviços.</p>
              </div>
              <div>
                <label htmlFor="repetir" className="field-label">Confirme a nova senha</label>
                <input id="repetir" type="password" value={form.repetir} onChange={set('repetir')} autoComplete="new-password" placeholder="Digite a mesma senha" className="input-field" />
              </div>
              {erro && (
                <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800 flex gap-2" role="alert">
                  <Icon name="alert" size={17} className="shrink-0 mt-0.5" />
                  {erro}
                </div>
              )}
              <button type="submit" disabled={salvando} className="w-full min-h-11 rounded-lg bg-brand-700 hover:bg-brand-800 text-white text-sm font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-2">
                {salvando && <span className="w-4 h-4 rounded-full border-2 border-white/35 border-t-white animate-spin" />}
                {salvando ? 'Criando senha…' : 'Criar senha e continuar'}
              </button>
            </form>
          )}
        </section>
      </div>
    </main>
  );
}
