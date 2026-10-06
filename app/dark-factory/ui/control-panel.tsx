import type { ReactNode } from "react";
import type {
  ControlAction,
  ControlScope,
  FactoryControlState,
  RunControlState,
} from "../../../agent/lib/dark-factory/control";
import type { RunStatus } from "../../../agent/lib/dark-factory/run-history";

export function ControlPanel({
  loading,
  error,
  unauthenticated,
  pending,
  factory,
  runId,
  run,
  runStatus,
  onAction,
}: {
  loading: boolean;
  error: string | null;
  unauthenticated: boolean;
  pending: boolean;
  factory?: FactoryControlState | null;
  runId?: string;
  run?: RunControlState | null;
  runStatus?: RunStatus;
  onAction: (action: ControlAction, scope: ControlScope) => void;
}): ReactNode {
  if (unauthenticated) {
    return (
      <p className="df-control-notice" role="status">
        Sign in to control the factory
      </p>
    );
  }
  if (loading && !factory) {
    return (
      <p className="df-control-notice" role="status">
        Loading control state…
      </p>
    );
  }
  if (error) {
    return (
      <p className="df-control-notice" role="alert">
        Control unavailable: {error}
      </p>
    );
  }

  const isRun = Boolean(runId);
  // Terminal runs (succeeded/failed/aborted) have already finished and must not
  // be stopped again. An explicit control stop (`run.stopped`) is terminal too.
  // A failed run is terminal but resumable — offer Resume (starts a new run)
  // and never a redundant Stop.
  const isTerminal =
    isRun &&
    Boolean(
      runStatus === "succeeded" ||
      runStatus === "failed" ||
      runStatus === "aborted" ||
      run?.stopped === true,
    );
  const isFailed = runStatus === "failed";
  const paused = isRun
    ? Boolean(run?.paused || factory?.paused)
    : Boolean(factory?.paused);
  const label = isRun
    ? isTerminal
      ? isFailed
        ? "Run failed"
        : runStatus === "succeeded"
          ? "Run succeeded"
          : runStatus === "aborted"
            ? "Run aborted"
            : "Run stopped"
      : paused
        ? "Run paused"
        : "Run running"
    : paused
      ? "Factory paused"
      : "Factory running";
  const indicator = isRun
    ? isTerminal
      ? "is-stopped"
      : paused
        ? "is-paused"
        : "is-running"
    : paused
      ? "is-paused"
      : "is-running";
  const state = isRun ? run : factory;
  const scope: ControlScope = isRun ? "run" : "factory";

  return (
    <section
      className="df-control-panel"
      aria-label={isRun ? "Run controls" : "Factory controls"}
    >
      <div className="df-control-state">
        <span
          className={`df-control-indicator ${indicator}`}
          aria-hidden="true"
        />
        <strong>{label}</strong>
        {state?.actor ? <small>{`by ${state.actor}`}</small> : null}
        {state?.updatedAt ? (
          <time dateTime={state.updatedAt}>{state.updatedAt}</time>
        ) : null}
      </div>
      <div className="df-control-actions">
        {isTerminal ? (
          isFailed ? (
            <button
              type="button"
              className="df-btn"
              disabled={pending}
              onClick={() => onAction("resume", scope)}
            >
              {isRun ? "Resume run" : "Resume factory"}
            </button>
          ) : (
            <span className="df-control-terminal">
              {runStatus === "succeeded"
                ? "Succeeded"
                : runStatus === "aborted"
                  ? "Aborted"
                  : "Stopped"}{" "}
              — cannot resume
            </span>
          )
        ) : (
          <>
            <button
              type="button"
              className="df-btn"
              disabled={pending}
              onClick={() => onAction(paused ? "resume" : "pause", scope)}
            >
              {paused
                ? isRun
                  ? "Resume run"
                  : "Resume factory"
                : isRun
                  ? "Pause run"
                  : "Pause factory"}
            </button>
            {isRun ? (
              <button
                type="button"
                className="df-btn df-btn-danger"
                disabled={pending}
                onClick={() => onAction("stop", "run")}
              >
                Stop run
              </button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
