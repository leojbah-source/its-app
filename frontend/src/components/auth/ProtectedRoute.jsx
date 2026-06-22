import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

export default function ProtectedRoute({ children, allowedRoles }) {
  const { isAuthenticated, user } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/admin/login" state={{ from: location }} replace />;
  }

  if (allowedRoles && user?.role && !allowedRoles.includes(user.role)) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50 px-6">
        <div className="max-w-sm rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <p className="text-base font-semibold text-navy-900">Restricted area</p>
          <p className="mt-1 text-sm text-slate-500">
            This page is only available to {allowedRoles.join(' / ')}. You're signed in as{' '}
            {user.role}.
          </p>
        </div>
      </div>
    );
  }

  return children;
}
