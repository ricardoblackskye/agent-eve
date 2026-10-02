#!/usr/bin/env python3
"""Mechanical refactor of app/globals.css: convert flat .df-* component classes
to native CSS nesting (&). Behavior-preserving by construction — the #241 test
(resolveRules bag) is the oracle; run `npx vitest run tests/css-nesting-migration.test.ts`
after this script and it must stay green.

Only consecutive, comma-free, single-selector .df-* rules that form a
`base` + `base-suffix` chain are nested. Everything else (the two app-page
styles, @media blocks, comments, .df-* rules with comma/descendant selectors)
is emitted verbatim.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "app" / "globals.css"


def parse_blocks(css: str):
    blocks = []
    i, n = 0, len(css)
    while i < n:
        while i < n and css[i] in " \t\r\n":
            i += 1
        if i >= n:
            break
        # comment block
        if css[i : i + 2] == "/*":
            endc = css.find("*/", i + 2)
            endc = endc + 2 if endc != -1 else n
            blocks.append(css[i:endc])
            i = endc
            continue
        start = i
        j = i
        while j < n and css[j] not in "{;":
            j += 1
        if j >= n:
            blocks.append(css[start:])
            break
        if css[j] == ";":
            blocks.append(css[start : j + 1])
            i = j + 1
            continue
        # rule / at-rule block: find matching brace
        depth = 0
        k = j
        while k < n:
            if css[k] == "{":
                depth += 1
            elif css[k] == "}":
                depth -= 1
                if depth == 0:
                    break
            k += 1
        blocks.append(css[start : k + 1])
        i = k + 1
    return blocks


def selector_of(block: str) -> str:
    idx = block.find("{")
    if idx == -1:
        return ""
    return block[:idx].strip()


def inner(block: str) -> str:
    a = block.find("{") + 1
    b = block.rfind("}")
    return block[a:b]


def groupable(block: str) -> bool:
    sel = selector_of(block)
    return sel.startswith(".df-") and "," not in sel and block.count("{") >= 1


def emit_nested(group, base_sel):
    base = group[0]
    base_decl = inner(base).strip()
    lines = [f"{base_sel} {{"]
    if base_decl:
        for dl in base_decl.splitlines():
            lines.append("  " + dl.strip())
    for child in group[1:]:
        csel = selector_of(child).replace(base_sel, "&", 1)
        cdecl = inner(child).strip()
        lines.append(f"  {csel} {{")
        if cdecl:
            for dl in cdecl.splitlines():
                lines.append("    " + dl.strip())
        lines.append("  }")
    lines.append("}")
    return "\n".join(lines) + "\n"


def main():
    css = TARGET.read_text(encoding="utf-8")
    blocks = parse_blocks(css)
    out = []
    i = 0
    while i < len(blocks):
        b = blocks[i]
        if groupable(b):
            group = [b]
            base_sel = selector_of(b)
            j = i + 1
            while j < len(blocks):
                nb = blocks[j]
                if groupable(nb) and selector_of(nb).startswith(base_sel + "-"):
                    group.append(nb)
                    j += 1
                else:
                    break
            if len(group) == 1:
                out.append(b)
            else:
                out.append(emit_nested(group, base_sel))
            i = j
        else:
            out.append(b)
            i += 1
    TARGET.write_text("".join(out), encoding="utf-8")
    print(f"rewrote {TARGET} ({len(blocks)} top-level blocks; {sum(1 for _ in out if '&' in _)} nested groups emitted)")


if __name__ == "__main__":
    main()
