import axios from 'axios';

// Fica true durante um logout/encerrarSuporte controlado (AuthContext). Sem
// isso, o `queryClient.clear()` do logout reativa na hora as queries que
// ainda estão montadas (ex.: polling do Monitor do admin) — elas batem aqui
// sem token e o redirect forçado pro /login atropela o navigate('/operador')
// da sessão de suporte. `login()` reseta a flag ao abrir uma sessão nova.
let sessaoEncerrando = false;
export function marcarSessaoEncerrando(valor) {
  sessaoEncerrando = valor;
}

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  timeout: 30_000,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  } else if (!config.url?.includes('/auth/') && !sessaoEncerrando) {
    window.location.href = '/login';
    return Promise.reject(new Error('Sessão encerrada'));
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    const isLoginEndpoint = err.config?.url?.includes('/auth/login');
    if (err.response?.status === 401 && !isLoginEndpoint) {
      localStorage.removeItem('token');
      if (!sessaoEncerrando) window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export default api;
