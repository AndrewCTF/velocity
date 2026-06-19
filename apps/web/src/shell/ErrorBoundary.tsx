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
    if (this.state.error) {
      return (
        <div className="p-3">
          <div className="micro text-alert">panel error</div>
          <div className="mono text-[11px] text-txt-2 mt-1">
            {this.props.label ? `${this.props.label}: ` : ''}
            {this.state.error.message}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
