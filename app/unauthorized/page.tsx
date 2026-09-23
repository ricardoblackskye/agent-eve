import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Unauthorized — Eve Agent",
};

/** Denied page (#99 AC): shown when the Google account is not on the allow-list. */
export default function Unauthorized() {
  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        gap: "0.75rem",
        fontFamily: "system-ui, sans-serif",
        textAlign: "center",
        padding: "2rem",
      }}
    >
      <h1 style={{ margin: 0 }}>You are not authorized to use Eve Chat</h1>
      <p style={{ margin: 0, opacity: 0.75 }}>
        Sign in with an approved Google account to continue.
      </p>
      <a href="/api/auth/google/start">Try a different account</a>
    </main>
  );
}
