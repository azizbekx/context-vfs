import { Component, ErrorInfo, ReactNode } from "react";

/**
 * Tiny error boundary. Catches render-time exceptions in its subtree and
 * shows a single line of mono text instead of letting the whole page go
 * blank. Mounted around the 3D scene because WebGL/three errors otherwise
 * wipe out the entire Lens view.
 */
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

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error(`[${this.props.label ?? "ErrorBoundary"}]`, error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="absolute inset-0 flex items-center justify-center p-8 bg-bg">
          <div className="surface-card p-6 max-w-xl">
            <div className="text-micro text-coral">
              {this.props.label ?? "Render error"}
            </div>
            <div className="text-meta text-ink mt-2 break-all">
              {this.state.error.message}
            </div>
            <div className="text-micro text-ink-faint normal-case tracking-normal mt-3">
              Open the browser console for the full stack.
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
