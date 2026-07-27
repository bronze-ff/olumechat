import axios from 'axios';

// Cliente HTTP do painel do OPERADOR (FIL-70).
//
// É um axios SEPARADO do services/api.js de propósito: sessão de operador e
// sessão de cliente não se misturam. Token em outra chave do localStorage
// ('token_operador'), outra rota de login e outra base ('/api/operador'). Se
// um dia alguém importar o `api` do cliente aqui, o painel do operador passa a
// mandar o token do tenant — que o servidor recusa com 403, mas o erro seria
// confuso; separar as duas instâncias evita a confusão na origem.
const apiOperador = axios.create({
  baseURL: (import.meta.env.VITE_API_URL || '/api') + '/operador',
  timeout: 30_000,
});

export const CHAVE_TOKEN = 'token_operador';

apiOperador.interceptors.request.use((config) => {
  const token = localStorage.getItem(CHAVE_TOKEN);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

apiOperador.interceptors.response.use(
  (res) => res,
  (err) => {
    const ehLogin = err.config?.url?.includes('/login');
    if (err.response?.status === 401 && !ehLogin) {
      localStorage.removeItem(CHAVE_TOKEN);
      window.location.href = '/operador/login';
    }
    return Promise.reject(err);
  }
);

export default apiOperador;
