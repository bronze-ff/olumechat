import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api, { marcarSessaoEncerrando } from '../services/api';
import { queryClient } from '../main';

const AuthContext = createContext(null);

function parseJwt(token) {
  try { return JSON.parse(atob(token.split('.')[1])); } catch { return null; }
}
function isTokenValid(token) {
  if (!token) return false;
  const payload = parseJwt(token);
  if (!payload) return false;
  return payload.exp * 1000 > Date.now();
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (isTokenValid(token)) {
      const p = parseJwt(token);
      // `suporte` = sessão administrativa temporária do operador dentro deste
      // tenant (FIL-70). O perfil do servidor chega como ADMIN, mas a marca
      // continua visível para indicar o modo de implantação e permitir voltar.
      setUser({ usuarioId: p.usuarioId, matricula: p.matricula, nome: p.nome, email: p.email,
                tenantId: p.tenantId, papel: 'ATENDENTE', deptoIds: [], podeAtivo: false,
                suporte: p.suporte === true });
      // Papel/departamentos não vivem no JWT (podem mudar sem relogin) — busca no
      // servidor. loading só cai DEPOIS do perfil chegar: senão o app pinta como
      // ATENDENTE por um instante (esconde menu de admin / redireciona no 1º paint).
      api.get('/auth/perfil')
        .then(({ data }) => setUser((u) => u && ({ ...u, papel: data.papel, deptoIds: data.deptoIds, podeAtivo: !!data.podeAtivo, iaHabilitada: !!data.iaHabilitada })))
        .catch(() => {})
        .finally(() => setLoading(false));
    } else {
      localStorage.removeItem('token');
      setLoading(false);
    }
  }, []);

  // Login próprio (FIL-67): empresa (slug do tenant) + e-mail + senha. O
  // `empresa` fica guardado só para pré-preencher o campo no próximo acesso —
  // quem manda no tenant é o `tenantId` assinado dentro do JWT.
  const login = useCallback(async (empresa, email, senha) => {
    const { data } = await api.post('/auth/login', { empresa, email, senha });
    // Sessão nova: reabilita o redirect automático em 401/token ausente
    // (suprimido durante um logout/encerrarSuporte controlado — ver api.js).
    marcarSessaoEncerrando(false);
    // Troca de identidade = cache velho não vale mais. `/login` é rota pública:
    // dá para entrar em OUTRA empresa sem passar pelo logout, e as queryKeys
    // não são qualificadas por tenant ('conversas', 'departamentos'...), então
    // as telas do tenant novo renderizariam dado do anterior até o refetch.
    // Mesma limpeza do logout, feita ANTES de publicar o novo usuário.
    queryClient.clear();
    localStorage.setItem('token', data.token);
    localStorage.setItem('empresa', data.empresa || empresa);
    const p = parseJwt(data.token);
    setUser({
      usuarioId: data.usuarioId, matricula: data.matricula, nome: data.nome,
      email: data.email, tenantId: p?.tenantId,
      papel: data.papel || 'ATENDENTE', deptoIds: data.deptoIds || [], podeAtivo: !!data.podeAtivo,
      iaHabilitada: !!data.iaHabilitada,
    });
    navigate('/conversas', { replace: true });
  }, [navigate]);

  const logout = useCallback(async () => {
    // Suprime o redirect automático do interceptor (api.js): sem isso, o
    // queryClient.clear() abaixo reativa na hora queries ainda montadas
    // (ex.: polling do Monitor do admin) e a resposta 401 delas dispara um
    // window.location.href pro /login que corrida com o navigate abaixo.
    marcarSessaoEncerrando(true);
    try { await api.post('/auth/logout'); } catch { /* ignora */ }
    localStorage.removeItem('token');
    queryClient.clear();
    setUser(null);
    navigate('/login', { replace: true });
  }, [navigate]);

  const encerrarSuporte = useCallback(async () => {
    // FIL-90: navegação DURA, não `navigate()` do router. Com `navigate()`
    // havia corrida com o `<Navigate to="/login">` que o ProtectedRoute do
    // cliente monta no mesmo ciclo (renderiza com `user=null` antes de o
    // router aplicar `/operador`) — o replace do /login rodava depois e
    // vencia. `window.location.assign` troca o documento inteiro: elimina a
    // corrida por construção e limpa de quebra todo o estado do painel do
    // cliente (React Query, SSE, contexto). Simetria com a ENTRADA da
    // implantação, que já é hard-nav.
    marcarSessaoEncerrando(true);
    try { await api.post('/auth/logout'); } catch { /* encerra localmente mesmo se a API falhar */ }
    localStorage.removeItem('token');
    queryClient.clear();
    setUser(null);
    window.location.assign('/operador/clientes');
  }, []);

  // Re-busca o perfil do servidor sem relogar — usado quando o PRÓPRIO usuário
  // tem o cadastro alterado (ex.: um admin que se auto-rebaixa a ATENDENTE), pra
  // o menu/permissões não ficarem congelados no papel antigo até dar reload.
  const refreshPerfil = useCallback(async () => {
    try {
      const { data } = await api.get('/auth/perfil');
      setUser((u) => u && ({ ...u, papel: data.papel, deptoIds: data.deptoIds, podeAtivo: !!data.podeAtivo, iaHabilitada: !!data.iaHabilitada }));
    } catch { /* ignora */ }
  }, []);

  const isAdmin = user?.papel === 'ADMIN';
  const isGestor = user?.papel === 'ADMIN' || user?.papel === 'SUPERVISOR';
  const isAuditor = user?.papel === 'AUDITOR';

  return (
    <AuthContext.Provider value={{ user, login, logout, encerrarSuporte, loading, isAuthenticated: !!user, isAdmin, isGestor, isAuditor, refreshPerfil }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
