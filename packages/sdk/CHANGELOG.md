# @insitue/sdk

## 0.4.16

- **Docs:** added Public API, Stability, Versioning, Security, and
  Tests sections to the README. The package was already well-
  documented for usage; the audit-template gaps were policy + scope
  surfaces consumers need before committing to a pin.
- **Code quality:** each `eslint-disable-next-line` now carries an
  inline justification (browser API gaps in `lib.dom`,
  intentional dev console output, stable-closure dep exclusion).
- **Cleanup:** swept past-tense storytelling and internal references
  from `capture.ts` JSDoc — removed a `~/.claude/plans/...` local-
  machine path leak, removed dated "verified on `<internal-app>`
  YYYY-MM-DD" annotations, and rewrote the "removed feature" comment
  block as a forward-looking explanation of the current design.
- **Metadata:** included `CHANGELOG.md` in the published tarball.

## 0.4.x and earlier

Pre-launch versions — see [git history](https://github.com/InSitue/insitue/commits/main/packages/sdk)
for changes. Real entries start at the next minor bump.
