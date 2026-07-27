import { Navigate, Outlet } from 'react-router-dom';
import { CHAVE_TOKEN } from '../../services/apiOperador';

// Guarda das rotas do painel do operador (FIL-70). Separada da ProtectedRoute
// do painel do cliente de propósito: são sessões diferentes, em chaves
// diferentes do localStorage, e uma nunca substitui a outra.
//
// A checagem aqui é só de UX (não mostrar a tela sem sessão). Quem autoriza de
// verdade é o servidor, em todo request — ver server/operador/middleware.js.
function tokenValido(token) {
  if (!token) return false;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

export default function RotaOperador() {
  if (!tokenValido(localStorage.getItem(CHAVE_TOKEN))) {
    return <Navigate to="/operador/login" replace />;
  }
  return <Outlet />;
}
