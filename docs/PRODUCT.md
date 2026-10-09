# Product

## The one-paragraph version

A desktop Git client that shows the shape of a repository — the commit graph, the refs, the
working tree — clearly enough that a person can decide what to do next without reading
`git log` output, and that can be driven entirely from a script or an AI agent instead of a
mouse. Local-first: no account, no cloud, no telemetry, no licence key. The graph and the
quick-command bar are the features the product is built around; everything else is in service
of them.

## Who it is for

| Person | What they are trying to do | What they need from us |
|---|---|---|
| A developer who lives in a terminal | read history, stage, commit, push, once in a while untangle a merge | a fast, honest view of the repository, and the option to hand the same operation to their terminal |
| A developer who does not | work with branches and pull requests without learning 40 commands | plain-language actions, nothing destructive without a reason |
| An AI agent working on a repository | inspect state, plan, apply one change, verify it | the same operations as the app, as JSON, with exit codes and a schema |
| A maintainer reviewing a change | understand what a branch contains | a graph that makes the branch boundary visible, and a diff that is readable |

The interesting overlap is the second and third: the same person is often both, and the same
repository is often touched by both in the same hour. That is the reason the CLI is not a
second product.

## What v1 has to do

Five things, and no more:

1. **Open a repository and draw it.** A list of recent repositories; one window per repository;
   a commit graph with lanes, refs and a readable diff for the selected commit.
2. **Manage the working tree.** Stage, unstage, discard, commit (with amend), see conflicts.
3. **Manage branches.** Create, switch, merge, delete, tag; see ahead/behind against the
   upstream.
4. **Sync.** Fetch, pull (fast-forward), push, with credentials from the system's own git
   credential helper rather than a vault of ours.
5. **Quick commands.** A bar of one-click operations, defined as data, with destructive ones
   asking for a reason first.

And one thing that has to be true from the first commit: **every one of those five is
available headlessly**, as `keplerk <command> --json`.

## The feature sift

Everything a graphical Git client normally carries, sorted. `Must` is v1, `Should` is the next
two releases, `Later` is deliberately unbuilt until someone asks, `Never` is a decision.

| Feature | Verdict | Why |
|---|---|---|
| Commit graph with lanes and refs | **Must** | the reason to open the app at all |
| Working-tree staging area | **Must** | the second thing anyone does |
| Unified diff viewer | **Must** | staging without reading the change is a guess |
| Side-by-side diff | **Should** | better for reviewing, more layout work than it looks |
| Branch/tag/remote management | **Must** | without it the app is a viewer, not a client |
| Quick-command bar | **Must** | the requested centrepiece: five actions in two seconds |
| Headless CLI with JSON | **Must** | it is the difference between a tool and a tool an agent can use |
| Repository list / recents | **Must** | first run has to lead somewhere |
| GitHub pull requests, review state, CI | **Should** | half of the daily use happens on the forge |
| GitLab merge requests, self-hosted instances | **Should** | same, and it is where the private installs are |
| Authentication via `gh`/`glab` or a PAT in the OS keychain | **Should** | reuse what the machine already has |
| Blame and file history | **Should** | needed to understand a line, not to change one |
| Interactive rebase with drag and drop | **Should** | high value, high risk: needs the plan-then-apply shape |
| Three-way merge editor | **Should** | conflicts are where people give up and open a terminal |
| Stash manager | **Should** | cheap once the working tree exists |
| Submodule support | **Later** | a small number of users, a large amount of UI |
| Git LFS | **Later** | pass-through works today; a real UI does not |
| Worktrees as first-class citizens | **Later** | quietly useful, seldom asked for |
| Hooks manager | **Later** | a text editor already exists |
| Multi-account, per-remote identities | **Later** | matters at work, not on the first run |
| Gitea/Forgejo/Bitbucket/Azure DevOps | **Later** | the adapter seam is the point; the code follows demand |
| Commit signing UI | **Later** | git config already covers it |
| Hosted accounts, cloud sync of settings | **Never** | it is the thing this product exists to avoid |
| Telemetry of any kind | **Never** | no |
| Proprietary features behind a licence | **Never** | MIT, all of it, or nothing |
| A proprietary account to use the app | **Never** | no |
| A web-only version | **Never** | the shell is Electron because it is not a web app |
| AI that writes commits unasked | **Never** | an agent may drive the CLI; the app does not invent changes |

## What makes it different

1. **The CLI is the same program.** Not a re-implementation, not a wrapper: one core package,
   two front-ends. This is enforced by an invariant, tested, and it is what makes agent use real
   rather than nominal.
2. **Every destructive action has to say why.** A confirmation is a reason string with a
   timestamp and a caller, not a boolean. It ends up in the log.
3. **Claims are measured or they are not made.** The README's numbers come from `make prove`,
   which builds real repositories with the real `git` binary. Nothing in the documentation is a
   number somebody remembered.
4. **Local-first, provider-agnostic.** The forge is an integration, not a dependency. A
   self-hosted instance on a private network is a first-class target.
5. **Boring about the hard part.** Git is the installed `git`, not a re-implementation of it;
   there is no second opinion about what a repository is.

## Non-goals

- Replacing `git`'s semantics. If `git` refuses something, we refuse it too, with a better message.
- Being faster than a terminal for a single command. It is faster for *understanding* a repository.
- Supporting every forge at launch.
- A plugin API before anyone has asked for one.
- Mobile, web, or a server component.

## Constraints and risks

| Risk | Why it bites | Mitigation |
|---|---|---|
| Installer size (Electron bundles a browser) | a 100 MB download for a Git client is a real objection | state it up front; the CI sizes the artifact so the number is known, not guessed |
| `git` not on `PATH` on Windows | the first run fails in a way that looks like our bug | `keplerk doctor` names it; bundling a git binary is a decision for a later release, not a surprise |
| Behaviour differences across platforms (path separators, `\n`, file modes) | the tests pass on macOS and the Windows user sees nothing | CI runs the suite on three operating systems; fixtures set `core.autocrlf=false` themselves |
| Provider APIs drift | an integration rots silently | recorded fixtures plus an opt-in live test against a containerised self-hosted forge |
| Scope creep toward "everything a Git client does" | the graph never gets good | the sift table above is the contract; `Later` means unbuilt |
| An agent doing something irreversible | trust, once broken, does not come back | destructive operations require a reason; `--dry-run` first; the same guard for the GUI and the CLI |
| The name collides with existing projects | renaming after release is expensive | see `docs/adr/0003-name.md`: the decision is open, the rename is one `grep` |

## How we will know it worked

- A person can open a repository, understand a branch, stage a file, commit and push without
  reading the `git` documentation.
- An agent can do the same through `keplerk --json`, with no screen involved.
- Every number in the README was produced by `make prove` on a machine that ran the code.
- A contributor can go from clone to a green `make verify` in one command.
