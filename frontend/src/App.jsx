import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
import ProtectedRoute from './components/auth/ProtectedRoute';
import Login from './pages/Login';
import YearConfig from './pages/YearConfig';
import Events from './pages/Events';
import Registrations from './pages/Registrations';

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/admin/login" element={<Login />} />
            <Route
              path="/admin/config/year"
              element={
                <ProtectedRoute>
                  <YearConfig />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/events"
              element={
                <ProtectedRoute>
                  <Events />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/registrations"
              element={
                <ProtectedRoute>
                  <Registrations />
                </ProtectedRoute>
              }
            />
            <Route path="/admin" element={<Navigate to="/admin/config/year" replace />} />
            <Route path="*" element={<Navigate to="/admin/login" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  );
}
