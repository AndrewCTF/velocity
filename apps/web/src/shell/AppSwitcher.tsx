import {
  Building2,
  Crosshair,
  Database,
  FileText,
  Flag,
  Globe,
  Radar,
  Search,
  Table2,
  Video,
  Waypoints,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { useAppView, APP_GROUPS, APP_META, type AppId } from '../state/appView.js';

// Icon per app — lives here (not in state/appView.ts) so the store stays
// UI-free. Exhaustive Record: adding an app without an icon fails typecheck.
const APP_ICONS: Record<AppId, LucideIcon> = {
  map: Globe,
  explorer: Table2,
  graph: Waypoints,
  investigate: Search,
  targeting: Crosshair,
  video: Video,
  sim: Radar,
  reports: FileText,
  foundry: Database,
  workflows: Workflow,
  city: Building2,
  country: Flag,
};

// Top-bar app switcher (design §6.1 grammar #3 — app-plural, not a tab pile).
// Grouped into labeled clusters (LIVE / ANALYZE / DATA / PRODUCT / 3D) so the
// row stays legible as apps are added; each cluster carries a tiny vertical
// group caption beside its buttons rather than a caption row above them, so
// the 42px command-bar height (ConsoleShell's fixed top grid row) never has
// to grow. Quiet chrome: the active app is the only lit cell.
export function AppSwitcher(): JSX.Element {
  const app = useAppView((s) => s.app);
  const setApp = useAppView((s) => s.setApp);
  return (
    <nav className="flex items-stretch h-full" aria-label="Applications">
      {APP_GROUPS.map((group, gi) => (
        <div
          key={group.id}
          className={`flex items-stretch h-full ${gi > 0 ? 'border-l border-line-2 ml-1 pl-1' : ''}`}
        >
          <span
            aria-hidden
            className="flex items-center justify-center px-[1px] font-label uppercase tracking-[0.5px] text-[8px] leading-none text-txt-4 select-none"
            style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
          >
            {group.label}
          </span>
          {group.apps.map((id: AppId) => {
            const active = id === app;
            const Ico = APP_ICONS[id];
            // Icon-forward to keep the 42px bar uncluttered: only the ACTIVE app
            // shows its label (so you always see where you are); the rest are
            // icon-only with the name + hint on hover. This is what keeps a
            // 12-app switcher from overflowing the top bar (operator: too crowded).
            return (
              <button
                key={id}
                type="button"
                onClick={() => setApp(id)}
                title={`${APP_META[id].label} — ${APP_META[id].hint}`}
                aria-current={active ? 'page' : undefined}
                aria-label={APP_META[id].label}
                className={`relative h-full flex items-center gap-1.5 font-label uppercase tracking-[0.9px] text-[11px] transition-colors ${
                  active ? 'px-2.5 text-txt-0 bg-bg-2/60' : 'px-2 text-txt-3 hover:text-txt-1 hover:bg-bg-2/40'
                }`}
              >
                <Ico aria-hidden className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                {active && <span className="whitespace-nowrap">{APP_META[id].label}</span>}
                {active && <span className="absolute left-2 right-2 bottom-0 h-[2px] bg-accent rounded-t-sm" />}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
