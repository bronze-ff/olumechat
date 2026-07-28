import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import apiOperador, { CHAVE_TOKEN } from '../../services/apiOperador';
import Brand from '../../components/ui/Brand';
import Icon from '../../components/ui/Icon';
import ThemeMenu from '../../components/ui/ThemeMenu';

export default function LoginOperador() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', senha: '' });
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(false);
  const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));

  async function entrar(event) {
    event.preventDefault();
    setErro('');
    if (!form.email || !form.senha) {
      setErro('Preencha e-mail e senha para continuar.');
      return;
    }
    setCarregando(true);
    try {
      const { data } = await apiOperador.post('/login', {
        email: form.email.trim().toLowerCase(),
        senha: form.senha,
      });
      localStorage.setItem(CHAVE_TOKEN, data.token);
      navigate('/operador', { replace: true });
    } catch (error) {
      setErro(error.response?.data?.error || 'Não foi possível entrar. Confira os dados e tente novamente.');
    } finally {
      setCarregando(false);
    }
  }

  return (
    <main className="relative min-h-screen bg-paper-100 grid lg:grid-cols-[minmax(340px,0.72fr)_1.28fr]">
      <div className="absolute top-4 right-4 z-20"><ThemeMenu /></div>
      <section className="hidden lg:flex bg-ink-950 text-white p-10 xl:p-12 flex-col">
        <Brand inverse />
        <div className="mt-auto mb-auto max-w-md">
          <span className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-[#47D7AE]/35 bg-[#47D7AE]/10 text-xs font-semibold text-[#7BE0C2]">
            <Icon name="shield" size={15} />
            Acesso interno restrito
          </span>
          <h1 className="mt-6 text-[34px] leading-[1.15] tracking-[-0.035em] font-semibold text-balance">
            Operação segura para toda a carteira Falatta.
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-white/50">
            Provisione empresas, acompanhe a adoção e configure canais em acessos de suporte auditados.
          </p>
        </div>
        <p className="text-xs text-white/65">Esta entrada não dá acesso ao atendimento de uma empresa.</p>
      </section>

      <section className="flex items-center justify-center px-5 py-10 sm:px-8">
        <div className="w-full max-w-[400px] bg-white border border-paper-300 rounded-xl p-6 sm:p-8 animate-slide-up">
          <div className="lg:hidden mb-9"><Brand /></div>
          <div className="w-10 h-10 rounded-xl bg-ink-950 text-white flex items-center justify-center">
            <Icon name="shield" size={19} />
          </div>
          <h2 className="mt-5 text-2xl font-semibold tracking-[-0.025em] text-ink-950">Central de operações</h2>
          <p className="mt-2 text-sm text-stone-600">Entre com sua conta interna da Falatta.</p>

          <form onSubmit={entrar} noValidate className="mt-7 space-y-5">
            <div>
              <label htmlFor="email" className="field-label">E-mail corporativo</label>
              <input id="email" type="email" className="input-field" value={form.email} onChange={set('email')} autoComplete="username" autoCapitalize="none" spellCheck="false" placeholder="voce@falatta.com" />
            </div>
            <div>
              <label htmlFor="senha" className="field-label">Senha</label>
              <input id="senha" type="password" className="input-field" value={form.senha} onChange={set('senha')} autoComplete="current-password" placeholder="Digite sua senha" />
            </div>

            {erro && (
              <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800 flex gap-2" role="alert">
                <Icon name="alert" size={17} className="shrink-0 mt-0.5" />
                {erro}
              </div>
            )}

            <button type="submit" disabled={carregando} className="w-full min-h-11 rounded-lg bg-ink-900 hover:bg-ink-950 text-white text-sm font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-2">
              {carregando && <span className="w-4 h-4 rounded-full border-2 border-white/35 border-t-white animate-spin" />}
              {carregando ? 'Verificando…' : 'Entrar na central'}
              {!carregando && <Icon name="arrow" size={16} />}
            </button>
          </form>

          <p className="mt-6 text-xs leading-relaxed text-stone-500">
            Contas internas são criadas no servidor por uma pessoa autorizada. Não existe cadastro público para operadores.
          </p>
        </div>
      </section>
    </main>
  );
}
