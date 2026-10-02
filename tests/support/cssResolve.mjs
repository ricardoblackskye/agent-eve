// Resolves CSS nesting (`&`) to flat selectors + declaration blocks.
// Used by the #241 drift-guard test and the baseline generator so the two
// always agree on what the stylesheet resolves to.
//
// A "rule" here is a leaf: a resolved selector and its declaration block.
// Nested rules recurse, expanding `&` against the enclosing resolved selector.

/**
 * @param {string} css
 * @returns {Array<[string, string]>} ordered list of [resolvedSelector, normalizedDeclarations]
 */
export function resolveRules(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, ""); // strip comments
  /** @type {Array<[string, string]>} */
  const rules = [];

  const normalize = (block) => block.replace(/\s+/g, " ").trim();

  const resolveOne = (sel, parent) => {
    if (sel.includes("&")) return sel.replace(/&/g, parent);
    return parent ? `${parent} ${sel}` : sel;
  };

  const parseRule = (pre, block, parent) => {
    const resolved = pre
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => resolveOne(s, parent));
    const firstBrace = block.indexOf("{");
    if (firstBrace === -1) {
      const decl = normalize(block);
      for (const r of resolved) rules.push([r, decl]);
      return;
    }
    const ownDecl = normalize(block.slice(0, firstBrace));
    if (ownDecl) for (const r of resolved) rules.push([r, ownDecl]);
    parse(block.slice(firstBrace), resolved[0]);
  };

  const parse = (str, parent) => {
    let i = 0;
    const n = str.length;
    while (i < n) {
      while (i < n && /\s/.test(str[i])) i++;
      if (i >= n) break;
      if (str[i] === "}") {
        i++;
        continue;
      }
      if (str[i] === "{") {
        i++;
        continue;
      }
      let pre = "";
      while (i < n && str[i] !== "{" && str[i] !== "}") pre += str[i++];
      pre = pre.trim();
      if (str[i] === "{") {
        i++;
        let block = "";
        let depth = 0;
        while (i < n) {
          const c = str[i];
          if (c === "{") depth++;
          else if (c === "}") {
            if (depth === 0) {
              i++;
              break;
            }
            depth--;
          }
          block += c;
          i++;
        }
        if (!pre) continue;
        const isAtRule = pre.startsWith("@");
        if (isAtRule) {
          parse(block, parent);
          continue;
        }
        parseRule(pre, block, parent);
      } else {
        // leaf with declarations only (no nested rules)
        i++;
        if (!pre) continue;
        const resolved = pre
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => resolveOne(s, parent));
        const decl = normalize(pre);
        for (const r of resolved) rules.push([r, decl]);
      }
    }
  };

  parse(css, "");
  return rules;
}
