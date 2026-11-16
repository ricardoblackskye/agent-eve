/**
 * #631 - the Developer persona's markdown is the source of truth; this renders the shipped module.
 *
 * RED stub: the signatures the tests need, with no behaviour. The implementation follows in the GREEN
 * commit.
 */

/** The body of each `<!-- developer-persona:start NAME -->` ... `end NAME` section, keyed by NAME. */
export function parseSections(_markdown: string): Record<string, string> {
  throw new Error("not implemented");
}

/** The TypeScript module text that ships the sections. */
export function renderIdentityModule(_sections: Record<string, string>): string {
  throw new Error("not implemented");
}
