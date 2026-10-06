"use client";

import { useState } from "react";
import { ApiError, signIn } from "@/lib/console-api";

export interface SignInProps {
  passwordConfigured: boolean;
  onSignedIn: () => void;
}

export function SignIn({ passwordConfigured, onSignedIn }: SignInProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(password);
      setPassword("");
      onSignedIn();
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 401 ? "that password did not match" : "sign in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <form className="signin-card" onSubmit={submit}>
        <h1 className="signin-title">Fluffles</h1>
        {passwordConfigured ? (
          <p className="signin-text">Enter the console password to chat with Fluffles.</p>
        ) : (
          <p className="signin-text">
            This console has no password configured, so it only serves local requests. Set CHAT_CONSOLE_PASSWORD on the console
            service to allow remote access.
          </p>
        )}
        <input
          className="signin-input"
          type="password"
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          disabled={!passwordConfigured || busy}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button className="signin-button" type="submit" disabled={!passwordConfigured || busy || password.length === 0}>
          {busy ? "Signing in..." : "Sign in"}
        </button>
        {error !== null && <p className="signin-error">{error}</p>}
      </form>
    </div>
  );
}
