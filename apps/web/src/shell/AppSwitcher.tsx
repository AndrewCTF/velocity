import { useAppView, APP_GROUPS, APP_META, type AppId } from '../state/appView.js';

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
        </div>
      ))}
    </nav>
  );
}
