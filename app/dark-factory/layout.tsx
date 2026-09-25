import Link from "next/link";
import type { ReactNode } from "react";

export default function DarkFactoryLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <div className="df-app">
      <aside className="df-rail" aria-label="Board navigation">
        <div className="df-mark">DF</div>
        <Link className="df-rail-link" href="/dark-factory" title="Overview">
          O
        </Link>
        <Link className="df-rail-link" href="/dark-factory/runs" title="Runs">
          R
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
        <div className="df-content">{children}</div>
      </div>
    </div>
  );
}
