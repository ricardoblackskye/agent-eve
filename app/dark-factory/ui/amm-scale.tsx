import type { ReactNode } from "react";

import {
  AMM_FLOOR_LEVEL,
  type AmmScan,
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
 */
export interface AmmScaleProps {
  repo: string;
  scan?: AmmScan;
}

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

      <ul className="df-amm-pillars">
        {scan.pillars.map((pillar) => (
          <li key={pillar.id} className="df-amm-pillar">
            <h3>{pillar.name}</h3>
            <span className="df-pill">{pillar.label}</span>
            {pillar.benchmark ? <p>{pillar.benchmark}</p> : null}

            {(pillar.signals?.length ?? 0) > 0 ? (
              <ul className="df-amm-signals">
                {(pillar.signals ?? []).map((signal) => (
                  <li
                    key={signal.id}
                    data-signal={signal.id}
                    data-present={signal.present ? "yes" : "no"}
                  >
                    <span aria-hidden="true">{signal.present ? "yes" : "no"}</span>{" "}
                    <span>{signal.label}</span> <small>L{signal.level}</small>
                  </li>
                ))}
              </ul>
            ) : null}

            {pillar.evidence.length > 0 ? (
              <p className="df-amm-evidence">{pillar.evidence.join(" · ")}</p>
            ) : null}
          </li>
        ))}
      </ul>

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
