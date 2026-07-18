import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
import { ParentAuthProvider, useParentAuth } from './context/ParentAuthContext';
import { JudgeAuthProvider, useJudgeAuth } from './context/JudgeAuthContext';
import ProtectedRoute from './components/auth/ProtectedRoute';

// Admin pages
import Login from './pages/Login';
import YearConfig from './pages/YearConfig';
import Events from './pages/Events';
import Registrations from './pages/Registrations';
import Lists from './pages/Lists';
import Schedule from './pages/Schedule';
import EventDay from './pages/EventDay';
import Judges from './pages/Judges';
import Assignment from './pages/judging/Assignment';
import Results from './pages/judging/Results';
import McPortal from './pages/mc/McPortal';

// Parent registration portal pages
import Landing from './pages/register/Landing';
import SignupPage from './pages/register/Signup';
import LoginPage from './pages/register/Login';
import Dashboard from './pages/register/Dashboard';
import ParticipantAdd from './pages/register/ParticipantAdd';
import ParticipantDetail from './pages/register/ParticipantDetail';
import TeamRegister from './pages/register/TeamRegister';
import JudgeLogin from './pages/judge/JudgeLogin';
import JudgeApp from './pages/judge/JudgeApp';

/** Redirects unauthenticated parents to the portal login. */
function ParentRoute({ children }) {
  const { isAuthenticated } = useParentAuth();
  if (!isAuthenticated) return <Navigate to="/register/login" replace />;
  return children;
}

function JudgeRoute({ children }) {
  const { isAuthenticated } = useJudgeAuth();
  if (!isAuthenticated) return <Navigate to="/judge/login" replace />;
  return children;
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <ParentAuthProvider>
          <JudgeAuthProvider>
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
              <Route
                path="/admin/event-day"
                element={<ProtectedRoute><EventDay /></ProtectedRoute>}
              />
              <Route
                path="/admin/judging/judges"
                element={<ProtectedRoute allowedRoles={['SuperAdmin', 'Chairman']}><Judges /></ProtectedRoute>}
              />
              <Route
                path="/admin/judging/assignment"
                element={<ProtectedRoute allowedRoles={['SuperAdmin', 'Chairman']}><Assignment /></ProtectedRoute>}
              />
              <Route
                path="/admin/judging/results"
                element={<ProtectedRoute allowedRoles={['SuperAdmin', 'Chairman']}><Results /></ProtectedRoute>}
              />
              <Route
                path="/mc"
                element={<ProtectedRoute allowedRoles={['MC', 'SuperAdmin', 'Chairman']}><McPortal /></ProtectedRoute>}
              />
              <Route path="/admin/judges" element={<Navigate to="/admin/judging/judges" replace />} />
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

              {/* ── Judge scoring portal ─────────────────────────────────── */}
              <Route path="/judge/login" element={<JudgeLogin />} />
              <Route path="/judge" element={<JudgeRoute><JudgeApp /></JudgeRoute>} />

              {/* ── Fallback ─────────────────────────────────────────────── */}
              <Route path="*" element={<Navigate to="/admin/login" replace />} />
            </Routes>
          </BrowserRouter>
          </JudgeAuthProvider>
        </ParentAuthProvider>
      </ToastProvider>
    </AuthProvider>
  );
}
