import type {
  EntityDecl,
  Expr,
  ParseResult,
  Range,
  RelationDecl,
} from "./parser";

export type Severity = "error" | "warning" | "off";

export interface LintOptions {
  namingConvention: Severity;
  unusedRelation: Severity;
  redundantParens: Severity;
}

export interface Diagnostic {
  message: string;
  range: Range;
  severity: "error" | "warning";
  source: "perm";
  code?: string;
}

const BUILTIN_TYPES = new Set(["boolean", "string", "integer", "double"]);
const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

export function lint(result: ParseResult, opts: LintOptions): Diagnostic[] {
  const diags: Diagnostic[] = [];

  for (const err of result.errors) {
    diags.push({
      message: err.message,
      range: err.range,
      severity: "error",
      source: "perm",
      code: "parse",
    });
  }

  const entityNames = new Map<string, EntityDecl>();
  const entityByName = new Map<string, EntityDecl>();
  for (const e of result.entities) {
    if (!e.name) continue;
    if (entityNames.has(e.name)) {
      diags.push({
        message: `Duplicate entity '${e.name}'`,
        range: e.nameRange,
        severity: "error",
        source: "perm",
        code: "duplicate-entity",
      });
    } else {
      entityNames.set(e.name, e);
      entityByName.set(e.name, e);
    }
    emitNaming(diags, opts, "entity", e.name, e.nameRange);
  }

  for (const e of result.entities) {
    checkEntity(e, entityByName, diags, opts);
  }

  return diags;
}

function checkEntity(
  e: EntityDecl,
  entities: Map<string, EntityDecl>,
  diags: Diagnostic[],
  opts: LintOptions,
): void {
  const memberNames = new Map<string, Range>();
  const relations = new Map<string, RelationDecl>();
  const usedRelations = new Set<string>();

  for (const m of e.members) {
    if (!m.name) continue;
    const prev = memberNames.get(m.name);
    if (prev) {
      diags.push({
        message: `Duplicate member '${m.name}' in entity '${e.name}'`,
        range: m.nameRange,
        severity: "error",
        source: "perm",
        code: "duplicate-member",
      });
    } else {
      memberNames.set(m.name, m.nameRange);
    }
    emitNaming(diags, opts, m.kind, m.name, m.nameRange);

    if (m.kind === "relation") {
      relations.set(m.name, m);
      for (const tgt of m.targets) {
        if (!entities.has(tgt.entity)) {
          diags.push({
            message: `Unknown entity '${tgt.entity}' in relation target`,
            range: tgt.range,
            severity: "error",
            source: "perm",
            code: "unknown-entity",
          });
        } else if (tgt.subjectRelation) {
          const tgtEntity = entities.get(tgt.entity)!;
          const hasRel = tgtEntity.members.some(
            (mm) => mm.kind === "relation" && mm.name === tgt.subjectRelation,
          );
          if (!hasRel) {
            diags.push({
              message: `Entity '${tgt.entity}' has no relation '${tgt.subjectRelation}'`,
              range: tgt.range,
              severity: "error",
              source: "perm",
              code: "unknown-subject-relation",
            });
          }
        }
      }
    }

    if (m.kind === "attribute" && m.attrType) {
      const base = m.attrType.replace(/\[\]$/, "");
      if (!BUILTIN_TYPES.has(base)) {
        diags.push({
          message: `Unknown attribute type '${m.attrType}'`,
          range: m.nameRange,
          severity: "error",
          source: "perm",
          code: "unknown-type",
        });
      }
    }

    if (m.kind === "rule") {
      for (const p of m.params) {
        const base = p.type.replace(/\[\]$/, "");
        if (!BUILTIN_TYPES.has(base)) {
          diags.push({
            message: `Unknown rule parameter type '${p.type}'`,
            range: p.range,
            severity: "error",
            source: "perm",
            code: "unknown-type",
          });
        }
      }
    }

    if ((m.kind === "permission" || m.kind === "action") && m.expression) {
      checkExpr(m.expression, e, entities, diags, opts, usedRelations);
    }
  }

  if (opts.unusedRelation !== "off") {
    for (const [name, rel] of relations) {
      if (!usedRelations.has(name)) {
        diags.push({
          message: `Relation '${name}' is declared but never used in a permission`,
          range: rel.nameRange,
          severity: opts.unusedRelation,
          source: "perm",
          code: "unused-relation",
        });
      }
    }
  }
}

function checkExpr(
  expr: Expr,
  entity: EntityDecl,
  entities: Map<string, EntityDecl>,
  diags: Diagnostic[],
  opts: LintOptions,
  usedRelations: Set<string>,
): void {
  switch (expr.kind) {
    case "ident": {
      if (!memberExists(entity, expr.name)) {
        diags.push({
          message: `'${expr.name}' is not a relation, permission, or attribute of entity '${entity.name}'`,
          range: expr.range,
          severity: "error",
          source: "perm",
          code: "unknown-ref",
        });
      } else {
        usedRelations.add(expr.name);
      }
      return;
    }
    case "member": {
      const root = rootIdent(expr);
      if (root) {
        if (!memberExists(entity, root.name)) {
          diags.push({
            message: `'${root.name}' is not a relation of entity '${entity.name}'`,
            range: root.range,
            severity: "error",
            source: "perm",
            code: "unknown-ref",
          });
        } else {
          usedRelations.add(root.name);
        }
      }
      checkMemberChain(expr, entity, entities, diags);
      return;
    }
    case "unary":
      checkExpr(expr.operand, entity, entities, diags, opts, usedRelations);
      return;
    case "binary":
      checkExpr(expr.left, entity, entities, diags, opts, usedRelations);
      checkExpr(expr.right, entity, entities, diags, opts, usedRelations);
      return;
    case "paren":
      if (
        opts.redundantParens !== "off" &&
        isTrivial(expr.inner)
      ) {
        diags.push({
          message: "Redundant parentheses",
          range: expr.range,
          severity: opts.redundantParens,
          source: "perm",
          code: "redundant-parens",
        });
      }
      checkExpr(expr.inner, entity, entities, diags, opts, usedRelations);
      return;
    case "call":
      for (const a of expr.args) {
        checkExpr(a, entity, entities, diags, opts, usedRelations);
      }
      return;
  }
}

function checkMemberChain(
  expr: Expr,
  entity: EntityDecl,
  entities: Map<string, EntityDecl>,
  diags: Diagnostic[],
): void {
  if (expr.kind !== "member") return;
  const root = rootIdent(expr);
  if (!root) return;
  const rel = entity.members.find(
    (m) => m.kind === "relation" && m.name === root.name,
  ) as RelationDecl | undefined;
  if (!rel || rel.targets.length === 0) return;

  const chain: string[] = [];
  let cur: Expr = expr;
  while (cur.kind === "member") {
    chain.unshift(cur.property);
    cur = cur.object;
  }

  let currentEntities = rel.targets
    .map((t) => entities.get(t.entity))
    .filter((e): e is EntityDecl => !!e);

  for (let i = 0; i < chain.length; i++) {
    const prop = chain[i];
    let nextEntities: EntityDecl[] = [];
    let found = false;
    for (const ce of currentEntities) {
      const mem = ce.members.find((m) => m.name === prop);
      if (!mem) continue;
      found = true;
      if (mem.kind === "relation") {
        for (const t of mem.targets) {
          const ne = entities.get(t.entity);
          if (ne) nextEntities.push(ne);
        }
      }
    }
    if (!found) {
      diags.push({
        message: `'${prop}' is not defined on referenced entity`,
        range: expr.range,
        severity: "error",
        source: "perm",
        code: "unknown-ref",
      });
      return;
    }
    currentEntities = nextEntities;
  }
}

function rootIdent(
  expr: Expr,
): { name: string; range: Range } | null {
  let cur: Expr = expr;
  while (cur.kind === "member") cur = cur.object;
  if (cur.kind === "ident") return { name: cur.name, range: cur.range };
  return null;
}

function memberExists(entity: EntityDecl, name: string): boolean {
  return entity.members.some((m) => m.name === name);
}

function isTrivial(expr: Expr): boolean {
  return (
    expr.kind === "ident" ||
    expr.kind === "member" ||
    expr.kind === "call" ||
    expr.kind === "paren"
  );
}

function emitNaming(
  diags: Diagnostic[],
  opts: LintOptions,
  kind: string,
  name: string,
  range: Range,
): void {
  if (opts.namingConvention === "off") return;
  if (!name) return;
  if (!SNAKE_CASE.test(name)) {
    diags.push({
      message: `${kind} name '${name}' should be snake_case`,
      range,
      severity: opts.namingConvention,
      source: "perm",
      code: "naming",
    });
  }
}
