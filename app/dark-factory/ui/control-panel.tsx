import type { ReactNode } from "react";
import type {
  ControlAction,
  ControlScope,
  FactoryControlState,
  RunControlState,
} from "../../../agent/lib/dark-factory/control";

export function ControlPanel({
  loading,
  error,
  unauthenticated,
  pending,
  factory,
  runId,
  run,
  onAction,
}: {
  loading: boolean;
  error: string | null;
  unauthenticated: boolean;
  pending: boolean;
  factory?: FactoryControlState | null;
  runId?: string;
  run?: RunControlState | null;
  onAction: (action: ControlAction, scope: ControlScope) => void;
}): ReactNode {
  if (unauthenticated) {
    return <p className="df-control-notice" role="status">Sign in to control the factory</p>;
  }
  if (loading && !factory) {
    return <p className="df-control-notice" role="status">Loading control state…</p>;
  }
  if (error) {
    return <p className="df-control-notice" role="alert">Control unavailable: {error}</p>;
  }

  const isRun = Boolean(runId);
  const stopped = isRun && run?.stopped === true;
  const paused = isRun ? Boolean(run?.paused || factory?.paused) : Boolean(factory?.paused);
  const label = isRun
    ? stopped ? "Run stopped" : paused ? "Run paused" : "Run running"
    : paused ? "Factory paused" : "Factory running";
  const state = isRun ? run : factory;
  const scope: ControlScope = isRun ? "run" : "factory";

  return (
    <section className="df-control-panel" aria-label={isRun ? "Run controls" : "Factory controls"}>
      <div className="df-control-state">
        <span className={`df-control-indicator ${stopped ? "is-stopped" : paused ? "is-paused" : "is-running"}`} aria-hidden="true" />
        <strong>{label}</strong>
        {state?.actor ? <small>{`by ${state.actor}`}</small> : null}
        {state?.updatedAt ? <time dateTime={state.updatedAt}>{state.updatedAt}</time> : null}
      </div>
      <div className="df-control-actions">
        {!stopped ? (
          <>
            <button type="button" className="df-btn" disabled={pending} onClick={() => onAction(paused ? "resume" : "pause", scope)}>
              {paused ? (isRun ? "Resume run" : "Resume factory") : (isRun ? "Pause run" : "Pause factory")}
            </button>
            {isRun ? (
              <button type="button" className="df-btn df-btn-danger" disabled={pending} onClick={() => onAction("stop", "run")}>
                Stop run
              </button>
            ) : null}
          </>
        ) : <span className="df-control-terminal">Stopped — cannot resume</span>}
      </div>
    </section>
  );
}
