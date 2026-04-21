import type {
  EntityDecl,
  EntityMember,
  Expr,
  ParseResult,
  PermissionDecl,
  RelationDecl,
  AttributeDecl,
  RuleDecl,
  Token,
} from "./parser";

export interface FormatOptions {
  indentSize: number;
  indentChar: " " | "\t";
  spaceAroundOperators: boolean;
  alignEquals: boolean;
  alignRelationTargets: boolean;
  trimTrailingWhitespace: boolean;
}

export function format(result: ParseResult, opts: FormatOptions): string {
  if (result.errors.length > 0) {
    return result.source;
  }

  const indent = (level: number): string =>
    opts.indentChar === "\t"
      ? "\t".repeat(level)
      : " ".repeat(level * opts.indentSize);

  const commentsByLine = collectComments(result.tokens);
  const usedComments = new Set<number>();
  const commentLines = [...commentsByLine.keys()].sort((a, b) => a - b);

  const takeLeadingComments = (line: number): string[] => {
    const out: string[] = [];
    for (const l of commentLines) {
      if (l >= line) break;
      const cs = commentsByLine.get(l);
      if (!cs) continue;
      for (const c of cs) {
        if (!usedComments.has(c.range.start.offset)) {
          out.push(c.value.trim());
          usedComments.add(c.range.start.offset);
        }
      }
    }
    return out;
  };

  const takeTrailingComment = (line: number): string | null => {
    const cs = commentsByLine.get(line);
    if (!cs) return null;
    for (const c of cs) {
      if (!usedComments.has(c.range.start.offset)) {
        usedComments.add(c.range.start.offset);
        return c.value.trim();
      }
    }
    return null;
  };

  const lines: string[] = [];

  result.entities.forEach((entity, idx) => {
    if (idx > 0) lines.push("");
    const lead = takeLeadingComments(entity.range.start.line);
    for (const c of lead) lines.push(c);
    lines.push(...formatEntity(entity, opts, indent, takeLeadingComments, takeTrailingComment));
  });

  const tailLead = takeLeadingComments(Number.MAX_SAFE_INTEGER);
  for (const c of tailLead) lines.push(c);

  let output = lines.join("\n");
  if (opts.trimTrailingWhitespace) {
    output = output
      .split("\n")
      .map((l) => l.replace(/[ \t]+$/, ""))
      .join("\n");
  }
  if (!output.endsWith("\n")) output += "\n";
  return output;
}

function collectComments(tokens: Token[]): Map<number, Token[]> {
  const map = new Map<number, Token[]>();
  for (const t of tokens) {
    if (t.kind !== "comment") continue;
    const line = t.range.start.line;
    const list = map.get(line) ?? [];
    list.push(t);
    map.set(line, list);
  }
  return map;
}

function formatEntity(
  e: EntityDecl,
  opts: FormatOptions,
  indent: (level: number) => string,
  takeLeading: (line: number) => string[],
  takeTrailing: (line: number) => string | null,
): string[] {
  const out: string[] = [];
  out.push(`entity ${e.name} {`);

  const grouped = groupMembers(e.members);

  grouped.forEach((group, gi) => {
    if (gi > 0) out.push("");
    const eqWidth = opts.alignEquals ? computeEqWidth(group) : 0;
    const relWidth = opts.alignRelationTargets ? computeRelWidth(group) : 0;
    for (const m of group) {
      const leading = takeLeading(m.range.start.line);
      for (const c of leading) out.push(`${indent(1)}${c}`);
      const line = formatMember(m, opts, eqWidth, relWidth);
      const trailing = takeTrailing(m.range.start.line);
      out.push(
        `${indent(1)}${line}${trailing ? ` ${trailing}` : ""}`,
      );
    }
  });

  out.push("}");
  return out;
}

function groupMembers(members: EntityMember[]): EntityMember[][] {
  const groups: EntityMember[][] = [];
  let current: EntityMember[] = [];
  let lastKind: string | null = null;
  for (const m of members) {
    if (lastKind && lastKind !== m.kind) {
      groups.push(current);
      current = [];
    }
    current.push(m);
    lastKind = m.kind;
  }
  if (current.length) groups.push(current);
  return groups;
}

function computeEqWidth(group: EntityMember[]): number {
  let w = 0;
  for (const m of group) {
    if (m.kind === "permission" || m.kind === "action") {
      w = Math.max(w, `${m.kind} ${m.name}`.length);
    }
  }
  return w;
}

function computeRelWidth(group: EntityMember[]): number {
  let w = 0;
  for (const m of group) {
    if (m.kind === "relation") {
      w = Math.max(w, `relation ${m.name}`.length);
    }
  }
  return w;
}

function formatMember(
  m: EntityMember,
  opts: FormatOptions,
  eqWidth: number,
  relWidth: number,
): string {
  switch (m.kind) {
    case "relation":
      return formatRelation(m, relWidth);
    case "permission":
    case "action":
      return formatPermission(m, opts, eqWidth);
    case "attribute":
      return formatAttribute(m);
    case "rule":
      return formatRule(m);
  }
}

function formatRelation(r: RelationDecl, relWidth: number): string {
  const targets = r.targets
    .map((t) => `@${t.entity}${t.subjectRelation ? `#${t.subjectRelation}` : ""}`)
    .join(" ");
  const head = `relation ${r.name}`;
  const padded = relWidth > 0 ? head.padEnd(relWidth, " ") : head;
  return `${padded} ${targets}`.trimEnd();
}

function formatPermission(
  p: PermissionDecl,
  opts: FormatOptions,
  eqWidth: number,
): string {
  const head = `${p.kind} ${p.name}`;
  const padded = opts.alignEquals ? head.padEnd(eqWidth, " ") : head;
  const expr = p.expression ? formatExpr(p.expression, opts) : "";
  const eq = opts.spaceAroundOperators ? " = " : "=";
  return `${padded}${eq}${expr}`;
}

function formatAttribute(a: AttributeDecl): string {
  return `attribute ${a.name}${a.attrType ? ` ${a.attrType}` : ""}`;
}

function formatRule(r: RuleDecl): string {
  const params = r.params.map((p) => `${p.name} ${p.type}`).join(", ");
  const body = r.bodyRange ? " { ... }" : "";
  return `rule ${r.name}(${params})${body}`;
}

function formatExpr(expr: Expr, opts: FormatOptions): string {
  const sp = opts.spaceAroundOperators ? " " : "";
  switch (expr.kind) {
    case "ident":
      return expr.name;
    case "member":
      return `${formatExpr(expr.object, opts)}.${expr.property}`;
    case "unary":
      return `not${sp || " "}${formatExpr(expr.operand, opts)}`;
    case "binary":
      return `${formatExpr(expr.left, opts)}${sp || " "}${expr.op}${sp || " "}${formatExpr(expr.right, opts)}`;
    case "paren":
      return `(${formatExpr(expr.inner, opts)})`;
    case "call":
      return `${expr.callee}(${expr.args.map((a) => formatExpr(a, opts)).join(", ")})`;
  }
}
