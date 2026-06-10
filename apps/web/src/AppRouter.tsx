import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { App } from './App.js';
import { App2D } from './App2D.js';

export function AppRouter(): JSX.Element {
  return (
    <BrowserRouter>
      <ModeBar />
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/2d" element={<App2D />} />
      </Routes>
    </BrowserRouter>
  );
}

function ModeBar(): JSX.Element {
  const loc = useLocation();
  const is2D = loc.pathname.startsWith('/2d');
  return (
    <div className="absolute top-1 right-2 z-[1000] flex gap-1">
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
  );
}
