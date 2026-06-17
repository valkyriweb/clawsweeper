export function Loading() {
  return (
    <div className="state-box center">
      <div className="spinner" aria-label="Loading…" />
      <span>Loading status…</span>
    </div>
  );
}

export function SignInPrompt() {
  return (
    <div className="state-box">
      <div className="sign-in-prompt">
        <p>Sign in to view the dashboard.</p>
        <a href="/login">Sign in with Google</a>
      </div>
    </div>
  );
}

export function FetchError({ message }: { message: string }) {
  return (
    <div className="state-box center">
      <div className="error-text">Error: {message}</div>
    </div>
  );
}
