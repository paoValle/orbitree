# Security

## What this program does with your secrets

`keplerk` reads repositories from your disk and runs the installed `git`. It does not have an
account, a server, or a place to send your data to.

- **Credentials** are used by whatever git itself uses: your system credential helper, your SSH
  agent, or a token you already have configured. They are never written to a file of ours.
- **Redaction happens on the way in.** Every `stdout` and `stderr` from a `git` process, and the
  message of every git error, passes through `redact` before anything can log, store or display it.
  Credentials embedded in URLs and known token shapes (GitHub, GitLab, AWS key ids, bearer
  headers) are removed. Invariant I8, tested in `packages/core/test/redact.test.ts`.
- **The renderer is untrusted by design**: `contextIsolation`, `sandbox`, no `nodeIntegration`,
  a CSP with no `eval` and no remote origins, a preload that exposes a fixed list of functions
  instead of a generic `invoke`, and every inbound IPC payload parsed before a git argument is
  built.
- **Nothing destructive runs without a confirmation**, and the confirmation is an attributed
  reason, not a boolean (invariant I1).

## Reporting a vulnerability

Open a [private security advisory](https://github.com/paoValle/keplerk/security/advisories/new) or
email the maintainer. Please include the version, the operating system, and what you did to make
it happen.

If it instead looks like a bug in the guard rails — a way to make a destructive command run
without a confirmation, a way to get a shell, a way to make a secret appear in output — that is a
security report even if it needs an unusual repository to trigger. Those invariants are the
product's promise.

**Do not** open a public issue for a vulnerability before a fix is available.

## What is in scope

- Bypassing a confirmation, or making `riskOf` classify an operation as non-destructive.
- Argument injection into a `git` process: any path, ref, branch name or commit message that
  changes the meaning of the argv.
- A secret reaching a log, a file, an IPC payload, or the screen.
- Escaping the renderer sandbox: a malicious repository (a crafted commit subject, file name or
  diff) causing code execution, or reaching an IPC channel that is not in the preload's list.
- Reading or writing a file outside the repository being worked on.

## What is not in scope

- A malicious `git` on your `PATH`, or a malicious credential helper: that is your machine.
- Vulnerabilities in `git` itself — report those upstream.
- Anything requiring an already-compromised renderer to be in place before the exploit.
- The installer not being signed yet. It will be before the first release (roadmap P7), and until
  then everything below "Status: pre-alpha" in the README applies.
