import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { App } from './App.js';
import { App2D } from './App2D.js';
import { AuthProvider, useAuth } from './auth/AuthContext.js';
import { LoginPage } from './auth/LoginPage.js';
import { SignupPage } from './auth/SignupPage.js';

// Served under the Vite base path (e.g. "/app" in production, "/" in dev), so
// the router's basename tracks it — keeps client routes correct behind /app.
const BASENAME = (import.meta.env.BASE_URL || '/').replace(/\/$/, '') || '/';

export function AppRouter(): JSX.Element {
  return (
    <BrowserRouter basename={BASENAME}>
      <AuthProvider>
        <TopBar />
        <Routes>
          <Route path="/" element={<App />} />
          <Route path="/2d" element={<App2D />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

function TopBar(): JSX.Element | null {
  const loc = useLocation();
  // The auth pages are full-screen cards — no overlay chrome on them.
  if (loc.pathname === '/login' || loc.pathname === '/signup') return null;
  const is2D = loc.pathname.startsWith('/2d');
  return (
    <div className="absolute top-1 right-2 z-[1000] flex items-center gap-2">
      <AccountChip />
      <div className="flex gap-1">
        <Link
          to="/"
          className={`mono text-[10px] px-2 py-0.5 border border-line rounded-sm ${!is2D ? 'text-accent border-accent-line' : 'text-txt-2 hover:border-accent-line'}`}
        >
          3D
        </Link>
        <Link
          to="/2d"
          className={`mono text-[10px] px-2 py-0.5 border border-line rounded-sm ${is2D ? 'text-accent border-accent-line' : 'text-txt-2 hover:border-accent-line'}`}
        >
          2D
        </Link>
      </div>
    </div>
  );
}

function AccountChip(): JSX.Element | null {
  const { user, loading, signOut } = useAuth();
  if (loading) return null;
  if (!user) {
    return (
      <Link
        to="/login"
        className="mono text-[10px] px-2 py-0.5 border border-line rounded-sm text-txt-2 hover:border-accent-line hover:text-accent"
      >
        Sign in
      </Link>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <span className="mono text-[10px] text-txt-2" title={user.email ?? user.id}>
        {user.email ?? user.id.slice(0, 8)}
      </span>
      <button
        type="button"
        onClick={() => void signOut()}
        className="mono text-[10px] px-2 py-0.5 border border-line rounded-sm text-txt-2 hover:border-accent-line hover:text-accent"
      >
        Sign out
      </button>
    </div>
  );
}
