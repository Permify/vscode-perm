import * as vscode from "vscode";
import { parse } from "./parser";
import { format, FormatOptions } from "./formatter";
import { lint, LintOptions, Diagnostic as PermDiag } from "./linter";

const LANG = "perm";

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection(LANG);
  context.subscriptions.push(diagnostics);

  const output = vscode.window.createOutputChannel("Perm");
  context.subscriptions.push(output);
  output.appendLine(`perm: activated at ${new Date().toISOString()}`);

  const MAX_LINT_BYTES = 500_000;
  const SLOW_MS = 50;
  const pending = new Map<string, NodeJS.Timeout>();

  const refreshNow = (doc: vscode.TextDocument): void => {
    if (doc.languageId !== LANG) return;
    const cfg = vscode.workspace.getConfiguration("perm");
    if (!cfg.get<boolean>("lint.enable", true)) {
      diagnostics.delete(doc.uri);
      return;
    }
    const text = doc.getText();
    if (text.length > MAX_LINT_BYTES) {
      diagnostics.delete(doc.uri);
      return;
    }
    try {
      const t0 = Date.now();
      const parsed = parse(text);
      const tParse = Date.now() - t0;
      const opts: LintOptions = {
        namingConvention: cfg.get("lint.namingConvention", "warning") as LintOptions["namingConvention"],
        unusedRelation: cfg.get("lint.unusedRelation", "warning") as LintOptions["unusedRelation"],
        redundantParens: cfg.get("lint.redundantParens", "warning") as LintOptions["redundantParens"],
      };
      const t1 = Date.now();
      const diags = lint(parsed, opts).map(toVscodeDiag);
      const tLint = Date.now() - t1;
      diagnostics.set(doc.uri, diags);
      if (tParse + tLint > SLOW_MS) {
        output.appendLine(
          `perm: slow refresh ${doc.uri.fsPath} bytes=${text.length} parse=${tParse}ms lint=${tLint}ms diags=${diags.length}`,
        );
      }
    } catch (e) {
      output.appendLine(`perm: lint failed ${(e as Error).message}`);
      diagnostics.delete(doc.uri);
    }
  };

  const refresh = (doc: vscode.TextDocument, delay = 200): void => {
    const key = doc.uri.toString();
    const prev = pending.get(key);
    if (prev) clearTimeout(prev);
    const handle = setTimeout(() => {
      pending.delete(key);
      refreshNow(doc);
    }, delay);
    pending.set(key, handle);
  };

  for (const doc of vscode.workspace.textDocuments) refreshNow(doc);

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((d) => refresh(d, 0)),
    vscode.workspace.onDidChangeTextDocument((e) => refresh(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => {
      diagnostics.delete(d.uri);
      const key = d.uri.toString();
      const prev = pending.get(key);
      if (prev) {
        clearTimeout(prev);
        pending.delete(key);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("perm")) return;
      for (const doc of vscode.workspace.textDocuments) refresh(doc, 0);
    }),
    { dispose: () => {
      for (const h of pending.values()) clearTimeout(h);
      pending.clear();
    } },
  );

  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(LANG, {
      provideDocumentFormattingEdits(
        doc: vscode.TextDocument,
        editorOpts: vscode.FormattingOptions,
      ): vscode.TextEdit[] {
        try {
          const cfg = vscode.workspace.getConfiguration("perm");
          const opts = resolveFormatOptions(cfg, editorOpts);
          const text = doc.getText();
          const t0 = Date.now();
          const parsed = parse(text);
          const formatted = format(parsed, opts);
          const total = Date.now() - t0;
          if (total > SLOW_MS) {
            output.appendLine(
              `perm: slow format ${doc.uri.fsPath} bytes=${text.length} total=${total}ms`,
            );
          }
          if (formatted === text) return [];
          const full = new vscode.Range(
            doc.positionAt(0),
            doc.positionAt(text.length),
          );
          return [vscode.TextEdit.replace(full, formatted)];
        } catch (e) {
          output.appendLine(`perm: format failed ${(e as Error).message}`);
          return [];
        }
      },
    }),
  );
}

export function deactivate(): void {
  // disposables are released via context.subscriptions
}

function resolveFormatOptions(
  cfg: vscode.WorkspaceConfiguration,
  editorOpts: vscode.FormattingOptions,
): FormatOptions {
  const styleSetting = cfg.get<string>("format.indentStyle", "auto");
  const useTab =
    styleSetting === "tab"
      ? true
      : styleSetting === "space"
        ? false
        : !editorOpts.insertSpaces;
  const sizeSetting = cfg.get<number | null>("format.indentSize", null);
  const indentSize =
    typeof sizeSetting === "number" && sizeSetting > 0
      ? sizeSetting
      : (editorOpts.tabSize as number);
  return {
    indentSize,
    indentChar: useTab ? "\t" : " ",
    spaceAroundOperators: cfg.get<boolean>("format.spaceAroundOperators", true),
    alignEquals: cfg.get<boolean>("format.alignEquals", true),
    alignRelationTargets: cfg.get<boolean>("format.alignRelationTargets", true),
    trimTrailingWhitespace: cfg.get<boolean>(
      "format.trimTrailingWhitespace",
      true,
    ),
  };
}

function toVscodeDiag(d: PermDiag): vscode.Diagnostic {
  const range = new vscode.Range(
    new vscode.Position(d.range.start.line, d.range.start.col),
    new vscode.Position(d.range.end.line, d.range.end.col),
  );
  const sev =
    d.severity === "error"
      ? vscode.DiagnosticSeverity.Error
      : vscode.DiagnosticSeverity.Warning;
  const diag = new vscode.Diagnostic(range, d.message, sev);
  diag.source = d.source;
  if (d.code) diag.code = d.code;
  return diag;
}
