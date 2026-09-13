import { Component, type ErrorInfo, type ReactNode } from 'react';

// Panel-level error boundary. A single panel that throws during render (e.g. a
// gated API returns 401/500 and a consumer assumed an array) must NOT take down
// the whole console — it shows a small inline fallback instead. Wrap each panel
// region so failures degrade locally rather than white-screening the app.
interface Props {
  children: ReactNode;
  label?: string;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep it in the console for debugging; don't crash the tree.
    console.error('[panel error]', this.props.label ?? '', error, info.componentStack);
  }

  render(): ReactNode {
    const err = this.state.error;
    if (err) {
      // The raw exception message is a stack-trace fragment, not copy (see the
      // Copy / voice rule in apps/web/CLAUDE.md). The user gets a sentence; the
      // detail stays one click and one console.error away.
      const label = this.props.label ? `The ${this.props.label} panel` : 'This panel';
      return (
        <div className="p-3">
          <div className="micro text-alert">panel error</div>
          <div className="text-[11px] text-txt-2 mt-1">
            {label} stopped rendering. The rest of the console is unaffected ·
            reselect or reload to try again.
          </div>
          <button
            type="button"
            className="micro text-txt-3 hover:text-accent mt-2"
            onClick={() => {
              void navigator.clipboard?.writeText(
                `${this.props.label ?? 'panel'}: ${err.message}`,
              );
            }}
          >
            Copy error detail
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
