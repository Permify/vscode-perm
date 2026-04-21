export type Pos = { line: number; col: number; offset: number };
export type Range = { start: Pos; end: Pos };

export type TokenKind =
  | "ident"
  | "number"
  | "string"
  | "keyword"
  | "symbol"
  | "comment"
  | "eof";

export interface Token {
  kind: TokenKind;
  value: string;
  range: Range;
}

export interface ParseError {
  message: string;
  range: Range;
  severity: "error";
}

export interface RelationDecl {
  kind: "relation";
  name: string;
  nameRange: Range;
  targets: { entity: string; subjectRelation?: string; range: Range }[];
  range: Range;
}

export interface PermissionDecl {
  kind: "permission" | "action";
  name: string;
  nameRange: Range;
  expression: Expr | null;
  expressionRange: Range | null;
  range: Range;
}

export interface AttributeDecl {
  kind: "attribute";
  name: string;
  nameRange: Range;
  attrType: string | null;
  range: Range;
}

export interface RuleDecl {
  kind: "rule";
  name: string;
  nameRange: Range;
  params: { name: string; type: string; range: Range }[];
  bodyRange: Range | null;
  range: Range;
}

export type EntityMember =
  | RelationDecl
  | PermissionDecl
  | AttributeDecl
  | RuleDecl;

export interface EntityDecl {
  kind: "entity";
  name: string;
  nameRange: Range;
  members: EntityMember[];
  range: Range;
  bodyOpenRange: Range | null;
  bodyCloseRange: Range | null;
}

export type Expr =
  | { kind: "ident"; name: string; range: Range }
  | { kind: "member"; object: Expr; property: string; range: Range }
  | { kind: "unary"; op: "not"; operand: Expr; range: Range }
  | {
      kind: "binary";
      op: "and" | "or";
      left: Expr;
      right: Expr;
      range: Range;
    }
  | { kind: "paren"; inner: Expr; range: Range }
  | { kind: "call"; callee: string; args: Expr[]; range: Range };

export interface ParseResult {
  entities: EntityDecl[];
  errors: ParseError[];
  tokens: Token[];
  source: string;
}

const KEYWORDS = new Set([
  "entity",
  "relation",
  "permission",
  "action",
  "attribute",
  "rule",
  "and",
  "or",
  "not",
  "in",
  "return",
]);

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 0;
  let col = 0;

  const pos = (): Pos => ({ line, col, offset: i });

  const advance = (n = 1): void => {
    for (let k = 0; k < n; k++) {
      if (source[i] === "\n") {
        line++;
        col = 0;
      } else {
        col++;
      }
      i++;
    }
  };

  const push = (kind: TokenKind, value: string, start: Pos): void => {
    tokens.push({ kind, value, range: { start, end: pos() } });
  };

  while (i < source.length) {
    const c = source[i];

    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      advance();
      continue;
    }

    if (c === "/" && source[i + 1] === "/") {
      const start = pos();
      while (i < source.length && source[i] !== "\n") advance();
      push("comment", source.slice(start.offset, i), start);
      continue;
    }

    if (c === "/" && source[i + 1] === "*") {
      const start = pos();
      advance(2);
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        advance();
      }
      if (i < source.length) advance(2);
      push("comment", source.slice(start.offset, i), start);
      continue;
    }

    if (c === '"' || c === "'") {
      const start = pos();
      const quote = c;
      advance();
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\" && i + 1 < source.length) advance(2);
        else advance();
      }
      if (source[i] === quote) advance();
      push("string", source.slice(start.offset, i), start);
      continue;
    }

    if (isIdentStart(c)) {
      const start = pos();
      while (i < source.length && isIdentPart(source[i])) advance();
      const value = source.slice(start.offset, i);
      push(KEYWORDS.has(value) ? "keyword" : "ident", value, start);
      continue;
    }

    if (isDigit(c)) {
      const start = pos();
      while (i < source.length && isDigit(source[i])) advance();
      if (source[i] === "." && isDigit(source[i + 1])) {
        advance();
        while (i < source.length && isDigit(source[i])) advance();
      }
      push("number", source.slice(start.offset, i), start);
      continue;
    }

    const twoChar = source.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(twoChar)) {
      const start = pos();
      advance(2);
      push("symbol", twoChar, start);
      continue;
    }

    if ("{}()[]@#=.,;<>+-*/!".includes(c)) {
      const start = pos();
      advance();
      push("symbol", c, start);
      continue;
    }

    const start = pos();
    advance();
    push("symbol", c, start);
  }

  tokens.push({ kind: "eof", value: "", range: { start: pos(), end: pos() } });
  return tokens;
}

function isIdentStart(c: string): boolean {
  return /[A-Za-z_]/.test(c);
}
function isIdentPart(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c);
}
function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

export function parse(source: string): ParseResult {
  const allTokens = tokenize(source);
  const tokens = allTokens.filter((t) => t.kind !== "comment");
  const errors: ParseError[] = [];
  const entities: EntityDecl[] = [];
  let p = 0;

  const peek = (o = 0): Token => tokens[Math.min(p + o, tokens.length - 1)];
  const eat = (): Token => tokens[p++];
  const atEnd = (): boolean => peek().kind === "eof";

  const err = (message: string, range: Range): void => {
    errors.push({ message, range, severity: "error" });
  };

  const expectSymbol = (s: string): Token | null => {
    const t = peek();
    if (t.kind === "symbol" && t.value === s) return eat();
    err(`Expected '${s}'`, t.range);
    return null;
  };

  const expectIdent = (what: string): Token | null => {
    const t = peek();
    if (t.kind === "ident") return eat();
    err(`Expected ${what}`, t.range);
    return null;
  };

  const skipUntil = (stop: (t: Token) => boolean): void => {
    while (!atEnd() && !stop(peek())) eat();
  };

  let topLastP = -1;
  while (!atEnd()) {
    if (p === topLastP) {
      eat();
      continue;
    }
    topLastP = p;
    const t = peek();
    if (t.kind === "keyword" && t.value === "entity") {
      entities.push(parseEntity());
    } else {
      err(`Unexpected '${t.value}' at top level`, t.range);
      eat();
    }
  }

  function parseEntity(): EntityDecl {
    const start = eat(); // entity keyword
    const nameTok = expectIdent("entity name");
    const name = nameTok?.value ?? "";
    const nameRange = nameTok?.range ?? start.range;

    let bodyOpenRange: Range | null = null;
    let bodyCloseRange: Range | null = null;
    const members: EntityMember[] = [];

    const openTok = peek();
    if (openTok.kind === "symbol" && openTok.value === "{") {
      bodyOpenRange = openTok.range;
      eat();
      let bodyLastP = -1;
      while (!atEnd()) {
        if (p === bodyLastP) {
          eat();
          continue;
        }
        bodyLastP = p;
        const t = peek();
        if (t.kind === "symbol" && t.value === "}") {
          bodyCloseRange = t.range;
          eat();
          break;
        }
        const member = parseMember();
        if (member) members.push(member);
      }
      if (!bodyCloseRange) {
        err("Unterminated entity body (missing '}')", nameRange);
      }
    } else {
      err("Expected '{' after entity name", openTok.range);
    }

    const endRange = bodyCloseRange ?? nameRange;
    return {
      kind: "entity",
      name,
      nameRange,
      members,
      range: { start: start.range.start, end: endRange.end },
      bodyOpenRange,
      bodyCloseRange,
    };
  }

  function parseMember(): EntityMember | null {
    const t = peek();
    if (t.kind !== "keyword") {
      err(`Unexpected '${t.value}'`, t.range);
      eat();
      return null;
    }
    switch (t.value) {
      case "relation":
        return parseRelation();
      case "permission":
      case "action":
        return parsePermission(t.value as "permission" | "action");
      case "attribute":
        return parseAttribute();
      case "rule":
        return parseRule();
      default:
        err(`Unexpected keyword '${t.value}' in entity body`, t.range);
        eat();
        return null;
    }
  }

  function parseRelation(): RelationDecl {
    const kw = eat();
    const nameTok = expectIdent("relation name");
    const name = nameTok?.value ?? "";
    const nameRange = nameTok?.range ?? kw.range;
    const targets: RelationDecl["targets"] = [];

    while (peek().kind === "symbol" && peek().value === "@") {
      const atTok = eat();
      const entTok = expectIdent("entity reference after '@'");
      const entity = entTok?.value ?? "";
      let subjectRelation: string | undefined;
      let endRange = entTok?.range ?? atTok.range;
      if (peek().kind === "symbol" && peek().value === "#") {
        eat();
        const relTok = expectIdent("subject relation after '#'");
        subjectRelation = relTok?.value;
        if (relTok) endRange = relTok.range;
      }
      targets.push({
        entity,
        subjectRelation,
        range: { start: atTok.range.start, end: endRange.end },
      });
    }

    if (targets.length === 0) {
      err(`Relation '${name}' must reference at least one entity (@name)`, nameRange);
    }

    const lastEnd = targets.length
      ? targets[targets.length - 1].range.end
      : nameRange.end;
    return {
      kind: "relation",
      name,
      nameRange,
      targets,
      range: { start: kw.range.start, end: lastEnd },
    };
  }

  function parsePermission(kind: "permission" | "action"): PermissionDecl {
    const kw = eat();
    const nameTok = expectIdent(`${kind} name`);
    const name = nameTok?.value ?? "";
    const nameRange = nameTok?.range ?? kw.range;
    let expression: Expr | null = null;
    let expressionRange: Range | null = null;

    const eq = peek();
    if (eq.kind === "symbol" && eq.value === "=") {
      eat();
      const exprStart = peek().range.start;
      expression = parseExpression();
      const exprEnd = expression ? expression.range.end : exprStart;
      expressionRange = { start: exprStart, end: exprEnd };
    } else {
      err(`Expected '=' after ${kind} name`, eq.range);
      skipUntil(
        (t) =>
          t.kind === "keyword" &&
          ["relation", "permission", "action", "attribute", "rule"].includes(
            t.value,
          ),
      );
    }

    const endPos = expressionRange?.end ?? nameRange.end;
    return {
      kind,
      name,
      nameRange,
      expression,
      expressionRange,
      range: { start: kw.range.start, end: endPos },
    };
  }

  function parseAttribute(): AttributeDecl {
    const kw = eat();
    const nameTok = expectIdent("attribute name");
    const name = nameTok?.value ?? "";
    const nameRange = nameTok?.range ?? kw.range;
    let attrType: string | null = null;
    let endRange = nameRange;
    const typeTok = peek();
    if (typeTok.kind === "ident" || typeTok.kind === "keyword") {
      eat();
      attrType = typeTok.value;
      endRange = typeTok.range;
      if (peek().kind === "symbol" && peek().value === "[") {
        eat();
        if (peek().kind === "symbol" && peek().value === "]") {
          const close = eat();
          attrType = `${attrType}[]`;
          endRange = close.range;
        } else {
          err("Expected ']' after '['", peek().range);
        }
      }
    } else {
      err("Expected attribute type", typeTok.range);
    }
    return {
      kind: "attribute",
      name,
      nameRange,
      attrType,
      range: { start: kw.range.start, end: endRange.end },
    };
  }

  function parseRule(): RuleDecl {
    const kw = eat();
    const nameTok = expectIdent("rule name");
    const name = nameTok?.value ?? "";
    const nameRange = nameTok?.range ?? kw.range;
    const params: RuleDecl["params"] = [];
    let bodyRange: Range | null = null;

    if (peek().kind === "symbol" && peek().value === "(") {
      eat();
      let lastP = -1;
      while (!atEnd() && !(peek().kind === "symbol" && peek().value === ")")) {
        if (p === lastP) {
          eat();
          continue;
        }
        lastP = p;
        const pnameTok = expectIdent("parameter name");
        const ptypeTok = peek();
        let type = "";
        let prange: Range = pnameTok?.range ?? kw.range;
        if (ptypeTok.kind === "ident" || ptypeTok.kind === "keyword") {
          eat();
          type = ptypeTok.value;
          if (peek().kind === "symbol" && peek().value === "[") {
            eat();
            if (peek().kind === "symbol" && peek().value === "]") {
              eat();
              type = `${type}[]`;
            }
          }
          prange = {
            start: pnameTok?.range.start ?? ptypeTok.range.start,
            end: ptypeTok.range.end,
          };
        } else {
          err("Expected parameter type", ptypeTok.range);
        }
        if (pnameTok) {
          params.push({ name: pnameTok.value, type, range: prange });
        }
        if (peek().kind === "symbol" && peek().value === ",") eat();
      }
      expectSymbol(")");
    } else {
      err("Expected '(' after rule name", peek().range);
    }

    if (peek().kind === "symbol" && peek().value === "{") {
      const open = eat();
      let depth = 1;
      let close: Token | null = null;
      while (!atEnd() && depth > 0) {
        const n = eat();
        if (n.kind === "symbol" && n.value === "{") depth++;
        else if (n.kind === "symbol" && n.value === "}") {
          depth--;
          if (depth === 0) close = n;
        }
      }
      if (close) {
        bodyRange = { start: open.range.start, end: close.range.end };
      } else {
        err("Unterminated rule body", open.range);
      }
    } else {
      err("Expected '{' after rule parameters", peek().range);
    }

    const endRange = bodyRange ?? nameRange;
    return {
      kind: "rule",
      name,
      nameRange,
      params,
      bodyRange,
      range: { start: kw.range.start, end: endRange.end },
    };
  }

  function parseExpression(): Expr | null {
    return parseOr();
  }

  function parseOr(): Expr | null {
    let left = parseAnd();
    while (peek().kind === "keyword" && peek().value === "or") {
      eat();
      const right = parseAnd();
      if (!left || !right) return left ?? right;
      left = {
        kind: "binary",
        op: "or",
        left,
        right,
        range: { start: left.range.start, end: right.range.end },
      };
    }
    return left;
  }

  function parseAnd(): Expr | null {
    let left = parseNot();
    while (peek().kind === "keyword" && peek().value === "and") {
      eat();
      const right = parseNot();
      if (!left || !right) return left ?? right;
      left = {
        kind: "binary",
        op: "and",
        left,
        right,
        range: { start: left.range.start, end: right.range.end },
      };
    }
    return left;
  }

  function parseNot(): Expr | null {
    if (peek().kind === "keyword" && peek().value === "not") {
      const kw = eat();
      const operand = parseNot();
      if (!operand) return null;
      return {
        kind: "unary",
        op: "not",
        operand,
        range: { start: kw.range.start, end: operand.range.end },
      };
    }
    return parsePrimary();
  }

  function parsePrimary(): Expr | null {
    const t = peek();
    if (t.kind === "symbol" && t.value === "(") {
      const open = eat();
      const inner = parseExpression();
      const close = expectSymbol(")");
      if (!inner) return null;
      return {
        kind: "paren",
        inner,
        range: {
          start: open.range.start,
          end: close ? close.range.end : inner.range.end,
        },
      };
    }
    if (t.kind === "ident") {
      eat();
      if (peek().kind === "symbol" && peek().value === "(") {
        eat();
        const args: Expr[] = [];
        let argLastP = -1;
        while (
          !atEnd() &&
          !(peek().kind === "symbol" && peek().value === ")")
        ) {
          if (p === argLastP) {
            eat();
            continue;
          }
          argLastP = p;
          const arg = parseExpression();
          if (arg) args.push(arg);
          if (peek().kind === "symbol" && peek().value === ",") eat();
        }
        const close = expectSymbol(")");
        return {
          kind: "call",
          callee: t.value,
          args,
          range: {
            start: t.range.start,
            end: close ? close.range.end : t.range.end,
          },
        };
      }
      let expr: Expr = { kind: "ident", name: t.value, range: t.range };
      while (peek().kind === "symbol" && peek().value === ".") {
        eat();
        const prop = expectIdent("property");
        if (!prop) break;
        expr = {
          kind: "member",
          object: expr,
          property: prop.value,
          range: { start: expr.range.start, end: prop.range.end },
        };
      }
      return expr;
    }
    err(`Unexpected token '${t.value}' in expression`, t.range);
    eat();
    return null;
  }

  return { entities, errors, tokens: allTokens, source };
}
