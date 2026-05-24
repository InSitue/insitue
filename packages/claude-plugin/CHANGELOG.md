# @insitue/claude-plugin

## 0.4.6

- **Fix (Windows):** `isInsideProject` now uses `path.sep` instead of a
  hardcoded `/`, so the project-dir sandbox check actually holds on
  Windows. Previously every `apply_edit` / `write_file` call would be
  rejected on Windows because `C:\proj/` never matches `C:\proj\file`.
- **Fix:** the MCP server's reported version (`McpServer({ version })`)
  is now read from `package.json` at startup, eliminating the stale
  `"0.3.0"` literal that drifted from the actual 0.4.x releases.
- **Fix:** stderr message on spawn-timeout now correctly reports "8 s"
  instead of "5 s" (the loop ceiling is 8 s).
- **Docs:** rewrote the README's Architecture section to match the
  current tool surface (next_pick, list_recent_picks, start_session,
  end_session, diagnose, read_file, apply_edit, write_file) — the
  previous text claimed only two tools and said "the bridge never
  writes files" (no longer true on Desktop).
- **Docs:** added Stability, Versioning, and Security sections to the
  README.
- **Docs:** swapped a leaked internal CMS-slug example
  (`briefings:hairspray-chipping:body`) for a generic one in
  `mcp-server.ts` JSDoc.
- **Docs:** clarified `project-dir.ts` JSDoc — said "three forms",
  listed six.
- **Metadata:** added `keywords`, `homepage`, `bugs` to `package.json`;
  included `CHANGELOG.md` in the published tarball.
- Bumped `.claude-plugin/plugin.json` version in lockstep.

## 0.4.x and earlier

Pre-launch versions — see [git history](https://github.com/InSitue/insitue/commits/main/packages/claude-plugin)
for changes. Real entries start at the next minor bump.
