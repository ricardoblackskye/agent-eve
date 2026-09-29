import type { ControlStore } from "./control";

export class PausedRunError extends Error {
  constructor(message = "Run paused at a cooperative checkpoint.") {
    super(message);
    this.name = "PausedRunError";
  }
}

export class StoppedRunError extends Error {
  constructor(message = "Run stopped at a cooperative checkpoint.") {
    super(message);
    this.name = "StoppedRunError";
  }
}

export class ControlUnavailableError extends Error {
  constructor(message = "Control state unavailable; refusing to continue work.") {
    super(message);
    this.name = "ControlUnavailableError";
  }
}

export function createControlCheckpoint(
  store: ControlStore,
  runId: string,
): () => Promise<void> {
  return async () => {
    try {
      const factory = await store.readFactory();
      if (!factory.ok) throw new ControlUnavailableError(factory.error);
      if (factory.value?.paused) throw new PausedRunError();

      const run = await store.readRun(runId);
      if (!run.ok) throw new ControlUnavailableError(run.error);
      if (run.value?.stopped) throw new StoppedRunError();
      if (run.value?.paused) throw new PausedRunError();
    } catch (error) {
      if (
        error instanceof PausedRunError ||
        error instanceof StoppedRunError ||
        error instanceof ControlUnavailableError
      ) {
        throw error;
      }
      throw new ControlUnavailableError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };
}
