/**
 * Env hygiene for spawned agent processes. By default we DELETE
 * `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` from the child env so
 * Claude Code falls back to the user's `claude login` (Max) — a stray
 * key would silently bill the API instead, and is an exfil surface.
 * `--allow-api-key` opts out explicitly.
 */
const API_KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

export function apiKeyVarsPresent(): string[] {
  return API_KEY_VARS.filter((k) => !!process.env[k]);
}

export function scrubbedEnv(allowApiKey: boolean): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!allowApiKey) {
    for (const k of API_KEY_VARS) delete env[k];
  }
  return env;
}
