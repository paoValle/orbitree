/**
 * What to do about a network failure, from what git and ssh printed.
 *
 * `stderr` is the truth about what happened and is useless to most readers: "Permission denied
 * (publickey)" is a sentence for somebody who already knows how ssh authentication works. This turns
 * the handful of failures that actually occur — a key that is not loaded, a token without the right
 * scope, a machine that cannot reach the host, a repository the account cannot see, a branch that has
 * moved — into the next step somebody should take.
 *
 * It matches text, which is a different kind of promise than a parser's: git changes its wording
 * between versions and localisations. So the list is deliberately small, the fallback is silence
 * rather than a guess (`null`), and what was printed is never replaced — a caller shows this *beside*
 * `stderr`, never instead of it.
 */

export type FailureKind =
  | 'ssh-key'
  | 'host-key'
  | 'token'
  | 'offline'
  | 'repository-not-found'
  | 'diverged'
  | 'refused-by-server';

export interface Diagnosis {
  readonly kind: FailureKind;
  /** What happened, in a sentence somebody who does not read git's stderr can act on. */
  readonly what: string;
  /** The next step. */
  readonly whatToDo: string;
}

interface Rule {
  readonly kind: FailureKind;
  readonly pattern: RegExp;
  readonly what: string;
  readonly whatToDo: string;
}

/**
 * Ordered: the first match wins, so the more specific message has to come before the more general
 * one.
 *
 * One thing deliberately not matched: git appends "Please make sure you have the correct access
 * rights and the repository exists" to *every* remote it cannot read — a path that is not a
 * repository, a repository the account cannot see, a host with no key — so that sentence is a
 * conclusion git reaches rather than a signal about why. Matching it made a wrong local path look
 * like an SSH key problem, which is what the test that pushes to a directory caught.
 */
const RULES: readonly Rule[] = [
  {
    kind: 'host-key',
    pattern: /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i,
    what: 'ssh does not trust the key the server presented.',
    whatToDo:
      'Compare the fingerprint with the one the server publishes, then add it to ~/.ssh/known_hosts (ssh-keyscan prints it, and it is worth checking out of band).',
  },
  {
    kind: 'token',
    pattern:
      /Authentication failed|HTTP Basic: Access denied|could not read Username|Support for password authentication was removed|invalid username or password|terminal prompts disabled/i,
    what: 'The password or token was refused.',
    whatToDo:
      'Put a working token in the credential helper (gh auth token, or the system keychain). Pushing needs the repo scope, and a private repository needs a token for an account that can see it.',
  },
  {
    kind: 'ssh-key',
    pattern: /Permission denied \(publickey|no supported authentication methods available/i,
    what: 'The server did not accept the SSH key this machine offered.',
    whatToDo:
      'Check the agent has the key (ssh-add -l lists them) and that the key is on the server for that account (ssh -T git@<host> says which account answered).',
  },
  {
    kind: 'repository-not-found',
    pattern:
      /Repository not found|does not appear to be a git repository|ERROR: Repository not found|remote: Not Found/i,
    what: 'The remote does not know that repository.',
    whatToDo:
      'Check the URL — orbitree remotes prints it — and that the account you are authenticating as can see the repository.',
  },
  {
    kind: 'offline',
    pattern:
      /Could not resolve host|Network is unreachable|Failed to connect to|Connection refused|Connection timed out|Operation timed out|Temporary failure in name resolution/i,
    what: 'Nothing answered at the other end.',
    whatToDo:
      'Check the network, then the remote URL: an unreachable host is a network problem, and a wrong port or address is a configuration one.',
  },
  {
    kind: 'diverged',
    pattern: /non-fast-forward|Updates were rejected because|\[rejected\]/i,
    what: 'The remote has commits this branch does not.',
    whatToDo:
      'Fetch and reconcile first — a pull fast-forwards and stops rather than inventing a merge — then push. A forced push rewrites what other people already have, so it stays a decision you take.',
  },
  {
    kind: 'refused-by-server',
    pattern: /protected branch|GH006|pre-receive hook declined|protected branch hook declined/i,
    what: "The server's own rules refuse this update to that branch or tag.",
    whatToDo:
      'Push a branch and ask for a review instead: the rule is the server’s, and the product has no button that pretends otherwise.',
  },
];

/**
 * The diagnosis for a failed command, or `null` when the failure is not one this knows.
 *
 * `null` is the answer for every ordinary local failure — a merge conflict, a missing file — and
 * saying nothing about those is the point: this is not a general error explainer.
 */
export function diagnoseFailure(stderr: string): Diagnosis | null {
  if (stderr.trim() === '') return null;
  for (const rule of RULES) {
    if (rule.pattern.test(stderr)) {
      return { kind: rule.kind, what: rule.what, whatToDo: rule.whatToDo };
    }
  }
  return null;
}
