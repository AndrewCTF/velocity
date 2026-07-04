import { useAppView, APP_IDS, APP_META, type AppId } from '../state/appView.js';

// Top-bar app switcher (design §6.1 grammar #3 — app-plural, not a tab pile).
// A segmented control of the seven top-level apps; the active one owns the map
// grid slot. Quiet chrome: the active app is the only lit cell.
export function AppSwitcher(): JSX.Element {
  const app = useAppView((s) => s.app);
  const setApp = useAppView((s) => s.setApp);
  return (
    <nav className="flex items-stretch h-full" aria-label="Applications">
      {APP_IDS.map((id: AppId) => {
        const active = id === app;
        return (
          <button
            key={id}
            type="button"
            onClick={() => setApp(id)}
            title={APP_META[id].hint}
            aria-current={active ? 'page' : undefined}
            className={`relative px-3 h-full flex items-center font-label uppercase tracking-[0.9px] text-[11px] transition-colors ${
              active
                ? 'text-txt-0'
                : 'text-txt-3 hover:text-txt-1'
            }`}
          >
            {APP_META[id].label}
            {active && (
              <span className="absolute left-2 right-2 bottom-0 h-[2px] bg-accent rounded-t-sm" />
            )}
          </button>
        );
      })}
    </nav>
  );
}
