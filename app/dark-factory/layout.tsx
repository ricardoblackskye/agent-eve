import Link from "next/link";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { resolveViewer } from "../api/dark-factory/viewer";
import { QueryProvider } from "./ui/query-provider";

export default async function DarkFactoryLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  // Entitlement is a membership, not a session: the same resolver the read API uses,
  // so the shell and the data cannot disagree about who is an operator.
  const incoming = await headers();
  const resolved = await resolveViewer(
    new Request("http://localhost/dark-factory", {
      headers: new Headers(incoming as unknown as HeadersInit),
    }),
  );
  if (!resolved.ok || resolved.viewer.role !== "operator") {
    return (
      <div className="df-app">
        <div className="df-content">
          <p>
            This surface is for dark factory operators. If you are signed in, ask an
            operator to grant your address.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="df-app">
      <aside className="df-rail" aria-label="Board navigation">
        <div className="df-mark">DF</div>
        <Link className="df-rail-link" href="/dark-factory" title="Overview">
          Overview
        </Link>
        <Link className="df-rail-link" href="/dark-factory/runs" title="Runs">
          Runs
        </Link>
        <Link className="df-rail-link" href="/dark-factory/repos" title="Repositories">
          Repositories
        </Link>
      </aside>
      <div className="df-main">
        <header className="df-top">
          <div className="df-brand">
            <strong>FACTORY / OPERATIONS</strong>
            <span>RUN LEDGER</span>
          </div>
          <div className="df-topright">
            <span className="df-live">POLLING 60S</span>
          </div>
        </header>
        <div className="df-content">
          <QueryProvider>{children}</QueryProvider>
        </div>
      </div>
    </div>
  );
}
