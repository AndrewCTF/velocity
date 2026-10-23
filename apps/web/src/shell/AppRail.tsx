import { APP_META, useAppView, type AppId } from "../state/appView.js";
import { BpIcon } from "./BpIcon.js";
import { APP_BP, APP_INK, RAIL_APPS } from "./appGlyphs.js";
import { toast } from "./toast.js";

// The rail's app column, at the reference rail's y offsets: eight coloured
// app glyphs from the top, Support, account and the AI app at the foot. Every
// other app is one click away (account state is the title bar's SignInChip) in the tabs bar's launcher.
const TOPS = [13, 56, 99, 142, 186, 229, 272, 315];

function AppButton({
  id,
  pos,
}: {
  id: AppId;
  pos: React.CSSProperties;
}): JSX.Element {
  const active = useAppView((s) => s.app);
  const setApp = useAppView((s) => s.setApp);
  return (
    <button
      type="button"
      className="csl2-app"
      style={{ ...pos, color: APP_INK[id] ?? "var(--c-rail-grey)" }}
      aria-current={id === active ? "page" : undefined}
      aria-label={`Open ${APP_META[id].label}`}
      title={`${APP_META[id].label} · ${APP_META[id].hint}`}
      onClick={() => setApp(id)}
    >
      <BpIcon name={APP_BP[id]} size={20} />
    </button>
  );
}

export function AppRail(): JSX.Element {
  return (
    <nav aria-label="Apps" className="contents">
      {RAIL_APPS.map((id, i) => (
        <AppButton key={id} id={id} pos={{ top: TOPS[i] }} />
      ))}
      <button
        type="button"
        className="csl2-app"
        style={{ bottom: 92 }}
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts"
        onClick={() =>
          toast.ok(
            "⌘K palette · ⌘J analyst console · A alerts · 1-4 left panels · Esc closes",
          )
        }
      >
        <BpIcon name="help" size={20} />
      </button>
      <AppButton id="ai" pos={{ bottom: 8 }} />
    </nav>
  );
}
