# Change Log

All notable changes to the "perm" extension will be documented in this file.

## [0.2.0]

- Add document formatter (`editor.formatOnSave` compatible).
- Add linter emitting diagnostics (errors + warnings) for `.perm` files:
  - Errors: parse failures, unknown entity/relation references, duplicate names, unbalanced braces, unknown attribute/rule types.
  - Warnings: non-snake_case names, unused relations, redundant parentheses.
- Configuration surface under `perm.format.*` and `perm.lint.*`.

## [0.1.0]

- Initial release.
