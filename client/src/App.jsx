import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import ProtectedRoute from './components/layout/ProtectedRoute';
import RotaOperador from './components/layout/RotaOperador';

import Login from './pages/Login';
import DefinirSenha from './pages/DefinirSenha';
import Conversas from './pages/Conversas';
import Admin from './pages/admin/Admin';
import LoginOperador from './pages/operador/LoginOperador';
import Operador from './pages/operador/Operador';

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          {/* Primeiro acesso: rota pública, chega por link com token. */}
          <Route path="/definir-senha" element={<DefinirSenha />} />
          {/* Painel do operador (FIL-70) — sessão própria, fora do RBAC do
              tenant e fora do AuthContext do painel do cliente. */}
          <Route path="/operador/login" element={<LoginOperador />} />
          <Route element={<RotaOperador />}>
            <Route path="/operador" element={<Operador />} />
          </Route>
          <Route element={<ProtectedRoute />}>
            <Route path="/"          element={<Navigate to="/conversas" replace />} />
            <Route path="/conversas" element={<Conversas />} />
            <Route path="/admin"     element={<Admin />} />
          </Route>
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
