import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
import { ParentAuthProvider, useParentAuth } from './context/ParentAuthContext';
import ProtectedRoute from './components/auth/ProtectedRoute';

// Admin pages
import Login from './pages/Login';
import YearConfig from './pages/YearConfig';
import Events from './pages/Events';
import Registrations from './pages/Registrations';
import Lists from './pages/Lists';
import Schedule from './pages/Schedule';

// Parent registration portal pages
import Landing from './pages/register/Landing';
import SignupPage from './pages/register/Signup';
import LoginPage from './pages/register/Login';
import Dashboard from './pages/register/Dashboard';
import ParticipantAdd from './pages/register/ParticipantAdd';
import ParticipantDetail from './pages/register/ParticipantDetail';
import TeamRegister from './pages/register/TeamRegister';

/** Redirects unauthenticated parents to the portal login. */
function ParentRoute({ children }) {
  const { isAuthenticated } = useParentAuth();
  if (!isAuthenticated) return <Navigate to="/register/login" replace />;
  return children;
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <ParentAuthProvider>
          <BrowserRouter>
            <Routes>
              {/* ── Admin routes ─────────────────────────────────────────── */}
              <Route path="/admin/login" element={<Login />} />
              <Route
                path="/admin/config/year"
                element={<ProtectedRoute><YearConfig /></ProtectedRoute>}
              />
              <Route
                path="/admin/events"
                element={<ProtectedRoute><Events /></ProtectedRoute>}
              />
              <Route
                path="/admin/registrations"
                element={<ProtectedRoute><Registrations /></ProtectedRoute>}
              />
              <Route
                path="/admin/lists"
                element={<ProtectedRoute><Lists /></ProtectedRoute>}
              />
              <Route
                path="/admin/schedule"
                element={<ProtectedRoute><Schedule /></ProtectedRoute>}
              />
              <Route path="/admin" element={<Navigate to="/admin/config/year" replace />} />

              {/* ── Parent registration portal ───────────────────────────── */}
              <Route path="/register" element={<Landing />} />
              <Route path="/register/login" element={<LoginPage />} />
              <Route path="/register/signup" element={<SignupPage />} />
              <Route
                path="/register/dashboard"
                element={<ParentRoute><Dashboard /></ParentRoute>}
              />
              <Route
                path="/register/add"
                element={<ParentRoute><ParticipantAdd /></ParentRoute>}
              />
              <Route
                path="/register/participant/:id"
                element={<ParentRoute><ParticipantDetail /></ParentRoute>}
              />
              <Route
                path="/register/team"
                element={<ParentRoute><TeamRegister /></ParentRoute>}
              />

              {/* ── Fallback ─────────────────────────────────────────────── */}
              <Route path="*" element={<Navigate to="/admin/login" replace />} />
            </Routes>
          </BrowserRouter>
        </ParentAuthProvider>
      </ToastProvider>
    </AuthProvider>
  );
}
