import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** When this changes (going to another page), the boundary tries again. */
  resetKey?: string;
  /** Where "Go to the dashboard" leads. Without it, only reloading is offered. */
  onHome?: () => void;
}
interface State { error: Error | null }

/**
 * Keeps one broken page from blanking the whole app. Without this, an error while showing a page made React
 * remove everything on screen (the v14 blank-page crash). Now the menu stays, the page says what happened, and
 * going anywhere else works as normal.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("A page could not be shown", error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page">
        <div className="banner bad" role="alert" style={{ flexWrap: "wrap", gap: 10 }}>
          <span className="grow">
            <b>This page could not be shown.</b> Something on it went wrong. Nothing was changed. Try again, or go somewhere else in the app.
          </span>
          <button className="btn small" onClick={() => this.setState({ error: null })}>Try again</button>
          {this.props.onHome ? <button className="btn small" onClick={this.props.onHome}>Go to the dashboard</button> : <button className="btn small" onClick={() => window.location.reload()}>Reload</button>}
        </div>
      </div>
    );
  }
}
