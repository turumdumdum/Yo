import { Component, type ReactNode } from 'react';

/**
 * Keeps one broken screen from blanking the whole app: shows a plain message with a way
 * back instead. `resetKey` clears the error when the person moves to another screen.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null; key?: string }> {
  override state: { error: Error | null; key?: string } = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey?: string }, state: { error: Error | null; key?: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  override componentDidCatch(error: Error) {
    console.error(error);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="card" role="alert">
        <h2>This part of the page could not be shown</h2>
        <p>Something went wrong while showing it. Your data is safe. Try again, or go to another tab.</p>
        <button type="button" className="button button-secondary" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </section>
    );
  }
}
