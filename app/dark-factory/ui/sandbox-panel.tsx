"use client";

import type { ReactNode } from "react";
import type { SandboxViewResponse } from "../../../agent/lib/dark-factory/sandbox-view";

export interface SandboxViewPanelProps {
  runId: string;
}

/**
 * #790 R1 (#791) - the operator's read-only window into a running local sandbox (task 5).
 *
 * The SERVER decides whether a view exists: this panel asks the endpoint and renders what it is told. That is what
 * keeps a deployed console honest - it has no local sandbox, so the endpoint answers `not-local` and no panel appears,
 * rather than a page pointing at a `127.0.0.1` that is not there.
 *
 * There is nothing to submit here. The panel lists paths, shows one file's contents, and offers a refresh; every
 * control is a read. The console's run controls live in `ControlPanel` and are deliberately not repeated.
 */
export function SandboxViewPanel(_props: SandboxViewPanelProps): ReactNode {
  return null;
}

export type { SandboxViewResponse };
