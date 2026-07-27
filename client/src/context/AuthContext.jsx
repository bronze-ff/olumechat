import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
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
      setUser({ usuarioId: p.usuarioId, matricula: p.matricula, nome: p.nome, email: p.email,
                tenantId: p.tenantId, papel: 'ATENDENTE', deptoIds: [], podeAtivo: false });
      // Papel/departamentos não vivem no JWT (podem mudar sem relogin) — busca no
      // servidor. loading só cai DEPOIS do perfil chegar: senão o app pinta como
      // ATENDENTE por um instante (esconde menu de admin / redireciona no 1º paint).
      api.get('/auth/perfil')
        .then(({ data }) => setUser((u) => u && ({ ...u, papel: data.papel, deptoIds: data.deptoIds, podeAtivo: !!data.podeAtivo })))
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
    localStorage.setItem('token', data.token);
    localStorage.setItem('empresa', data.empresa || empresa);
    const p = parseJwt(data.token);
    setUser({
      usuarioId: data.usuarioId, matricula: data.matricula, nome: data.nome,
      email: data.email, tenantId: p?.tenantId,
      papel: data.papel || 'ATENDENTE', deptoIds: data.deptoIds || [], podeAtivo: !!data.podeAtivo,
    });
    navigate('/conversas', { replace: true });
  }, [navigate]);

  const logout = useCallback(async () => {
    try { await api.post('/auth/logout'); } catch { /* ignora */ }
    localStorage.removeItem('token');
    queryClient.clear();
    setUser(null);
    navigate('/login', { replace: true });
  }, [navigate]);

  // Re-busca o perfil do servidor sem relogar — usado quando o PRÓPRIO usuário
  // tem o cadastro alterado (ex.: um admin que se auto-rebaixa a ATENDENTE), pra
  // o menu/permissões não ficarem congelados no papel antigo até dar reload.
  const refreshPerfil = useCallback(async () => {
    try {
      const { data } = await api.get('/auth/perfil');
      setUser((u) => u && ({ ...u, papel: data.papel, deptoIds: data.deptoIds, podeAtivo: !!data.podeAtivo }));
    } catch { /* ignora */ }
  }, []);

  const isAdmin = user?.papel === 'ADMIN';
  const isGestor = user?.papel === 'ADMIN' || user?.papel === 'SUPERVISOR';

  return (
    <AuthContext.Provider value={{ user, login, logout, loading, isAuthenticated: !!user, isAdmin, isGestor, refreshPerfil }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
