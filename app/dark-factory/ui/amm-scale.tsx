import { Fragment, type ReactNode } from "react";

import {
  AMM_FLOOR_LEVEL,
  type AmmScan,
  type AmmSignal,
} from "../../../agent/lib/dark-factory/amm-readiness";
import { PanelHead } from "./components";

/**
 * #415 (epic #403 R3) — the AMM readiness scale.
 *
 * Every metric, level, benchmark and signal comes from the scan: this component holds NO pillar names, no metric set
 * and no point values of its own. That is deliberate, because the catalogue belongs to the scorer - the whitepaper
 * scores BINARY signals, each worth its level's points - and a component that knew the eight pillars would need
 * editing the day the scanner reports a ninth. The test that renders a different metric set is what holds this line.
 *
 * A missing scan is a state, not an error: a repository can be configured before it has been scored.
 *
 * #433 — the results render as a table (Pillar | Signal | Level | Result) rather than nested bullets, so a scan can be
 * read at a glance. The pillar is a `rowgroup` cell spanning its signals, which keeps the grouping without repeating
 * the name on every row, and its benchmark/evidence rides a muted row beneath.
 */
export interface AmmScaleProps {
  repo: string;
  scan?: AmmScan;
}

/**
 * The three outcomes a signal can have. `unmeasured` is a first-class state rather than a shade of `absent`: the
 * board's standing rule is that an unmeasured value is never a zero and never a failure — it means nobody looked.
 */
type SignalResult = "present" | "absent" | "unmeasured";

/** Prefer the scan's own `state`; fall back to `present` for R1/R3 fixtures that predate the third state. */
function resultOf(signal: AmmSignal): SignalResult {
  return signal.state ?? (signal.present ? "present" : "absent");
}

const RESULT_LABEL: Record<SignalResult, string> = {
  present: "Present",
  absent: "Absent",
  unmeasured: "Not measured",
};

export function AmmScale({ repo, scan }: AmmScaleProps): ReactNode {
  if (!scan) {
    return (
      <section className="df-panel" aria-label="AMM readiness">
        <PanelHead title="AMM readiness" />
        <p className="df-panel-empty">
          No readiness scan yet for {repo}. It appears here once the AMM scanner
          has scored it.
        </p>
      </section>
    );
  }

  const { overall } = scan;

  return (
    <section className="df-panel" aria-label="AMM readiness">
      <PanelHead title="AMM readiness" />
      <p className="df-panel-subtitle">
        {overall.label} · {overall.points} / {overall.maxPoints} points ·
        production floor: Level {AMM_FLOOR_LEVEL}
      </p>

      <table className="df-amm-table">
        <thead>
          <tr>
            <th scope="col">Pillar</th>
            <th scope="col">Signal</th>
            <th scope="col">Level</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {scan.pillars.map((pillar) => {
            const signals = pillar.signals ?? [];
            return (
              <Fragment key={pillar.id}>
                {signals.length > 0 ? (
                  signals.map((signal, index) => {
                    const result = resultOf(signal);
                    return (
                      <tr
                        key={signal.id}
                        data-signal={signal.id}
                        data-present={signal.present ? "yes" : "no"}
                        data-state={result}
                      >
                        {index === 0 ? (
                          <th
                            className="df-amm-pillar"
                            scope="rowgroup"
                            rowSpan={signals.length}
                          >
                            {pillar.name}
                          </th>
                        ) : null}
                        <td>{signal.label}</td>
                        <td className="df-amm-level">L{signal.level}</td>
                        <td className="df-amm-result" data-result={result}>
                          {RESULT_LABEL[result]}
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <th className="df-amm-pillar" scope="rowgroup" rowSpan={1}>
                      {pillar.name}
                    </th>
                    <td className="df-amm-none">No signals reported</td>
                    <td className="df-amm-level">—</td>
                    <td className="df-amm-result">—</td>
                  </tr>
                )}
                <tr className="df-amm-meta">
                  <td colSpan={4}>
                    <span className="df-pill">{pillar.label}</span>
                    {pillar.benchmark ? ` ${pillar.benchmark}` : ""}
                    {pillar.evidence.length > 0
                      ? ` · ${pillar.evidence.join(" · ")}`
                      : ""}
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>

      {scan.capabilities.length > 0 ? (
        <>
          <PanelHead title="Autonomous processes" />
          <ul className="df-amm-capabilities">
            {scan.capabilities.map((capability) => (
              <li key={capability.name}>
                <span>{capability.name}</span> <small>{capability.stage}</small>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
