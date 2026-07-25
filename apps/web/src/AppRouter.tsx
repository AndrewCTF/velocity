import { Suspense, lazy, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { App } from './App.js';
import { AuthProvider, useAuth } from './auth/AuthContext.js';
import { SettingsModal } from './settings/SettingsModal.js';
import { useSettings } from './state/settings.js';
import { useAppView, APP_META } from './state/appView.js';
import { Onboarding, hasOnboarded } from './onboarding/Onboarding.js';
import { isSupabaseConfigured } from './transport/supabase.js';
import { AiSetupWizard } from './settings/localAi/AiSetupWizard.js';
import { hasSeenAiSetup } from './settings/localAi/aiSetupSeen.js';
import { fetchModelsOnce } from './settings/localAi/LocalAiSection.js';
import { ToastHost } from './shell/toast.js';
import { LowEndBanner } from './globe/LowEndBanner.js';

// Served under the Vite base path (e.g. "/app" in production, "/" in dev), so
// the router's basename tracks it — keeps client routes correct behind /app.
const BASENAME = (import.meta.env.BASE_URL || '/').replace(/\/$/, '') || '/';

// Secondary routes are code-split so "/" (the console everyone lands on) does
// not pay for their heavy deps: App2D pulls maplibre-gl, StudioPage pulls
// three + the splat viewer. The console route (App) stays eager — it IS the
// product; lazy-loading it would only add a loading seam to every visit.
const App2D = lazy(() => import('./App2D.js').then((m) => ({ default: m.App2D })));
const StudioPage = lazy(() => import('./studio/StudioPage.js').then((m) => ({ default: m.StudioPage })));
const VelocityNewsPage = lazy(() =>
  import('./news/VelocityNewsPage.js').then((m) => ({ default: m.VelocityNewsPage })),
);
const StoryView = lazy(() => import('./news/StoryView.js').then((m) => ({ default: m.StoryView })));
const LoginPage = lazy(() => import('./auth/LoginPage.js').then((m) => ({ default: m.LoginPage })));
const SignupPage = lazy(() => import('./auth/SignupPage.js').then((m) => ({ default: m.SignupPage })));
const AuthForm = lazy(() => import('./auth/AuthForm.js').then((m) => ({ default: m.AuthForm })));

function RouteLoading(): JSX.Element {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <span className="mono text-[11px] text-txt-2">loading…</span>
    </div>
  );
}

export function AppRouter(): JSX.Element {
  return (
    <BrowserRouter basename={BASENAME}>
      <AuthProvider>
        <TopBar />
        <PredictedMotionBadge />
        <LowEndBanner />
        <OnboardingGate />
        <AiSetupGate />
        <Suspense fallback={<RouteLoading />}>
          <Routes>
            <Route path="/" element={<DashboardRoute />} />
            <Route path="/2d" element={<App2D />} />
            <Route path="/studio" element={<StudioPage />} />
            <Route path="/news" element={<VelocityNewsPage />} />
            <Route path="/news/:id" element={<StoryView />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route path="/forgot" element={<AuthForm mode="forgot" />} />
            <Route path="/reset" element={<AuthForm mode="reset" />} />
          </Routes>
        </Suspense>
        <ToastHost />
      </AuthProvider>
    </BrowserRouter>
  );
}

// The "/" route now renders the SINGLE Gotham console shell (App) for every mode
// (design §6.0 — the parallel "Normal" shell is retired). dashboardMode selects a
// view PRESET of that one shell: 'professional' = Command (dense, all apps),
// 'normal' = Field (a lighter landing). App reads the mode and adapts.
function DashboardRoute(): JSX.Element {
  return <App />;
}

function TopBar(): JSX.Element | null {
  const loc = useLocation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The auth pages are full-screen cards — no overlay chrome on them.
  if (['/login', '/signup', '/forgot', '/reset'].includes(loc.pathname)) return null;
  if (loc.pathname.startsWith('/news')) return null;
  const is2D = loc.pathname.startsWith('/2d');
  const isStudio = loc.pathname.startsWith('/studio');
  return (
    <div className="absolute top-1 right-2 z-[var(--z-dock)] flex items-center gap-2">
      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        title="Settings: dashboard, aircraft motion & API keys"
        className="mono text-[10px] px-2 py-0.5 border border-line rounded-sm text-txt-2 hover:border-accent-line hover:text-accent"
      >
        ⚙ Settings
      </button>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      <AccountChip />
      <div className="flex gap-1">
        <Link
          to="/"
          className={`mono text-[10px] px-2 py-0.5 border border-line rounded-sm ${!is2D && !isStudio ? 'text-accent border-accent-line' : 'text-txt-2 hover:border-accent-line'}`}
        >
          3D
        </Link>
        <Link
          to="/2d"
          className={`mono text-[10px] px-2 py-0.5 border border-line rounded-sm ${is2D ? 'text-accent border-accent-line' : 'text-txt-2 hover:border-accent-line'}`}
        >
          2D
        </Link>
        <Link
          to="/studio"
          className={`mono text-[10px] px-2 py-0.5 border border-line rounded-sm ${isStudio ? 'text-accent border-accent-line' : 'text-txt-2 hover:border-accent-line'}`}
        >
          STUDIO
        </Link>
      </div>
    </div>
  );
}

// Honest marker for the dead-reckoning opt-in: while aircraft positions are
// being ESTIMATED between ADS-B fixes, a pulsing chip on the map says so. Only
// on the live map routes ("/" and "/2d"), only when the setting is ON.
function PredictedMotionBadge(): JSX.Element | null {
  const loc = useLocation();
  const on = useSettings((s) => s.aircraftDeadReckon);
  const activeApp = useAppView((s) => s.app);
  if (!on) return null;
  if (loc.pathname !== '/' && !loc.pathname.startsWith('/2d')) return null;
  // The badge annotates aircraft on the globe. A full-surface app (AI, Foundry,
  // Workflows, City, Country) covers the globe, so the badge is meaningless
  // there — and worse, the app surface clips its 427px width down to a stray
  // "● Pr" at the left edge. Hide it whenever the globe isn't the active view.
  if (loc.pathname === '/' && APP_META[activeApp].chrome === 'full') return null;
  // The console home ("/") stacks a ~158px timeline footer AND the AgentConsole's
  // resting slash-hints row above it; sit clear of BOTH so the badge never lands
  // in the console's text band. The 2D route has a clear bottom.
  const bottomClass = loc.pathname === '/' ? 'bottom-[280px]' : 'bottom-2';
  // Centered so it never sits under the left tool flyout (Layers/Feeds/etc.),
  // which overlays the map's bottom-left corner where this used to pin.
  return (
    <div className={`absolute ${bottomClass} left-1/2 -translate-x-1/2 z-[var(--z-dock)] mono text-[10px] px-2 py-1 rounded-sm border border-accent-line bg-bg-1/90 text-accent pointer-events-none flex items-center gap-1.5`}>
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
      Predicted motion: aircraft positions estimated between ADS-B fixes
    </div>
  );
}

// First-run tour. Only on the live map routes ("/" and "/2d") — auth, news and
// studio pages get no overlay. Shows once, then localStorage remembers it.
function OnboardingGate(): JSX.Element | null {
  const loc = useLocation();
  const [show, setShow] = useState(() => !hasOnboarded());
  const onMap = loc.pathname === '/' || loc.pathname.startsWith('/2d');
  if (!show || !onMap) return null;
  return <Onboarding onClose={() => setShow(false)} />;
}

// First-run local-AI setup wizard gate. Only on the live map routes, only
// once per browser (velocity.aiSetupSeen), and only when there's actually
// nothing to route to yet: zero installed models AND llama.cpp isn't already
// running (an operator who already has a model or a hand-run llama-server
// doesn't need the wizard nagging them).
function AiSetupGate(): JSX.Element | null {
  const loc = useLocation();
  const onMap = loc.pathname === '/' || loc.pathname.startsWith('/2d');
  const [show, setShow] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!onMap || hasSeenAiSetup() || checked) return;
    let live = true;
    void (async () => {
      const models = await fetchModelsOnce();
      if (!live) return;
      setChecked(true);
      if (!models) return; // backend unreachable — don't nag with a broken wizard
      const noModels = models.installed.length === 0;
      const llamaRunning = models.engines.llamacpp.running;
      if (noModels && !llamaRunning) setShow(true);
    })();
    return () => {
      live = false;
    };
  }, [onMap, checked]);

  if (!show || !onMap) return null;
  return <AiSetupWizard onClose={() => setShow(false)} />;
}

function AccountChip(): JSX.Element | null {
  const { user, loading, signOut } = useAuth();
  // Local / self-host build: no Supabase env → auth is disabled, so there's
  // nothing to sign into. Hide the chip entirely (no "Sign in" link).
  if (!isSupabaseConfigured) return null;
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
