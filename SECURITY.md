# Security policy

## Reporting a vulnerability

Email **security@insitue.com** with a description of the issue, reproduction steps if possible, and the affected package(s) and version(s).

Do **not** open a public issue for vulnerabilities. Please give us a reasonable window to investigate and ship a fix before public disclosure.

We acknowledge reports within **5 business days** and aim to ship a fix for confirmed high-severity issues within **30 days**. We'll keep you in the loop on triage and credit you in the release notes if you'd like.

## What's in scope

Vulnerabilities in the **local-loop dev tool** packages published from this repo:

- `@insitue/sdk` (browser overlay)
- `@insitue/companion` (local Node process)
- `@insitue/claude-plugin` (Claude Code integration)
- `@insitue/capture-core` (shared schema)

Examples of in-scope issues:

- The companion's loopback WS server accepting handshakes from foreign origins
- Token leakage in the session file
- Path traversal in the edit gateway (writing outside the project sandbox)
- XSS / DOM injection from the SDK overlay's Shadow DOM
- Dependency vulnerabilities in shipped dist
- Anything that lets a webpage in the user's browser read or write files outside what the user explicitly picked

## What's out of scope (here)

- Vulnerabilities in the hosted **InSitue Cloud** product at `www.insitue.com`. Those go through the cloud-product disclosure process; same email address, mention "cloud" in the subject.
- Issues in third-party dependencies — please report those upstream and let us know so we can update or pin.
- Theoretical attacks that require local code execution on the user's machine (the threat model assumes the user's machine is not already compromised).
- Reports from automated scanners with no demonstrated exploit.

## Threat model — what we protect

The local-loop trust boundary is:

1. The companion binds **`127.0.0.1` only**. It is not reachable from another machine on the same network.
2. The companion's handshake is **origin-pinned** to one dev-server origin per session.
3. The companion **refuses to run with `NODE_ENV=production`**.
4. The companion's edit gateway can only write to **paths inside the project directory** that was set at startup.
5. The session token is delivered only through the origin-pinned handshake (M0). M1 will tighten this so only the dev server, not any local process, can obtain it.

If you've found a way around any of these, that's a real vulnerability and we want to hear about it.

## Bug bounty

We don't run a paid bounty program at the moment. We do credit researchers in release notes and in a future security acknowledgements page if you'd like the recognition.
