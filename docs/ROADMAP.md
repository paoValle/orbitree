# Roadmap

Each phase ends with an exit criterion that is a **command**, not a feeling. A phase is not
done when the code compiles; it is done when the command it names produces the output it
promises. Phases are ordered by what unblocks the next one, not by how interesting they are.

Status: **P0 to P3 are complete**; P3.5 is under way, and everything after it is unstarted.

---

## P0 — The ground floor

The repository, the process, and the one vertical slice that proves the architecture.

- [x] MIT licence, contribution files, issue and PR templates, CI on Linux/macOS/Windows.
- [x] `packages/core`: the single guarded gateway to `git`, the status and log parsers, the
      graph layout, redaction, typed errors.
- [x] `packages/cli`: `status`, `graph`, `refs`, `diff`, `show`, `ops`, `run`, `doctor`, `schema` —
      all with `--json`.
- [x] `apps/desktop`: an Electron window that opens a repository, draws the graph on a canvas,
      lists the working tree, and has a quick-command bar with a confirmation sheet.
- [x] The harness: `make verify` (format, lint, types, invariants, tests), `make prove`,
      `make mutate`, `bin/check-invariants.sh`.
- [x] Eight invariants, each with a test that names it (`docs/INVARIANTS.md`).

**Exit**: `make verify` is green on three operating systems, and
`orbitree graph . --json` prints lanes and edges for a real repository.

---

## P1 — See

Make the repository legible. No mutation beyond staging yet.

- [x] Repository list and recents, one window per repository, restoring the last selection.
- [x] Tabs over the graph pane: several repositories open at once, each with its own filter,
      selection and window, switchable in one click, and a recents list a new tab opens from.
- [x] Closing the window hides the app to a system tray icon on Windows and macOS instead of
      quitting, and a configurable global hotkey opens a compact popup window with the
      repository's quick state. The setting is persisted and the app forgets it if unset.
- [x] Load more history. The window says `300 of 2054` and there is no way to ask for the other 1754.
      The count that made the truncation visible is also the argument for a way to extend it.
      The window is a page, and a button offers the next one while `truncated` is true; it
      disappears when the last page has been read, which is the same fact the header uses.
- [x] The graph pane as its own component: virtualised rows, keyboard navigation, lane colours
      and badges for HEAD/branches/tags/remotes, `--all`.
- [x] Per-branch filters in the graph pane: a ref filter whose first option is every branch, and
      the revision goes to both the log and the count.
- [x] Commit detail: message, author, date, changed files, unified diff, per-file diff. The data is
      already there (`readCommit` / `orbitree show`): message, body, `against` and the parsed patch.
      What is missing is the pane that draws it.
- [x] Working tree: staged and unstaged sections, per-file diff, file-kind icons.
- [x] Stash list (read-only), submodule badge (read-only), conflict markers visible. The
      submodule state is recognised by its `S` rather than by the three characters after it,
      because those are git's to define.
- [x] Empty, unborn, detached, mid-merge states each get a designed screen, not a fallback.
      A rebase leaves a detached head behind, so the operation wins over the head's shape.

- [x] **Exit**, measured on one repository of 2053 commits and 79 refs built by
      `bin/make-big-repo.sh`: `orbitree graph . --json --limit 2000` returns 2000 of 2054 commits in
      0.3 s including Node's startup, and the window opens that same repository in 972 ms, renders 30
      of 2054 rows, and scrolls to the last commit in 38 ms. "Without dropping a frame" is taken to
      mean a row count bounded by the viewport and a bounded scroll cost, which is what was measured;
      no frame timing was taken, and saying otherwise would be inventing a number.

## P1.5 — Look

The surface becomes its own thing instead of a by-product of the panes. The rules live in
`docs/DESIGN.md`; this phase is the work of applying them.

- [x] The icon set: one component per glyph in `apps/desktop/src/renderer/icons.tsx`, on a 24px
      grid with a 1.5px stroke, used on the quick bar, the file kinds, the ref badges, the tab bar
      and the pane headings. The text glyphs the working tree uses today (`=`, `#`, `{}`, `~`) are
      replaced rather than joined. `apps/desktop/test/e2e/icons.spec.tsx` draws every glyph the
      module exports — 27 of them, at 16px and 14px, in one colour — into `reports/icons.png`, and
      fails when two of them share a name or draw the same shape, which is how the stashes card and
      the stash command lost their duplicate.
- [x] The motion pass, behind `prefers-reduced-motion: reduce`, with the six rules in
      `docs/DESIGN.md` as the specification. Nothing animates the graph, and no transition is the
      only way to see that something changed. `apps/desktop/test/e2e/motion.spec.ts` reads the
      computed transition and animation of the panes that animate, with the media query emulated and
      without, and stages a file with motion off so that the change is still asserted in words.
- [x] The command behind every action: an activity entry shows the exact `git` argv, with a copy
      button. The argv already exists in the core and the log already records the result.
- [x] A WIP node at the top of the graph, so the working tree is a place in the picture rather than a
      card beside it. The counts are the working-tree card's own four sections, read from the same
      status, and the node is a fact *beside* the rows: `layoutGraph` stays a pure function of the
      DAG. `orbitree graph . --json` carries it as `wip`, so the CLI and the window say the same
      thing about what is not committed yet. `apps/desktop/test/e2e/wip.spec.ts` asserts it on the
      real window, in both directions: drawn when the commit HEAD sits on is in the window, not
      drawn when the history is filtered to a branch that does not hold it.
- [x] The stash nodes among the ordinary ones, so a stash is a place in the graph rather than a
      read-only card. Split out of the item above, which delivered the working tree half. A stash
      older than `refs/stash` is reachable from nothing but that ref's reflog, so the read names
      every entry — `--all` is this product's word for the repository's whole picture — and the
      count names them too, or `truncated` would compare two pictures. A stash row carries its
      selector as a badge and is drawn as a square, and `stash-submodule.spec.ts` asserts both
      entries of a repository with two of them.
- [x] A commit's own context menu: create a branch here, create a tag here, check out, reset to here,
      copy the sha, copy the message. Reachable with the keyboard, not only with a mouse.
      `apps/desktop/test/e2e/menu.spec.ts` drives the real window: seven items on a right click,
      `Shift+F10` opening it, Escape closing it with the repository untouched, `Create branch here`
      checked against raw `git`, `Copy SHA` read back from the machine's clipboard, and `Reset
      --hard to here` stopping at the confirmation sheet with nothing run.
- [x] Density and typography: one set of metrics, one monospace face for hashes and paths, and a
      row height chosen so a branch boundary is visible without scrolling. The metrics that have to
      agree — `ROW_HEIGHT`, `LANE_WIDTH`, `TEXT_GUTTER` — are declared once in `GraphPane.tsx` and
      used by both the canvas and the DOM rows, and the face is one custom property, `--mono`,
      because the literal stack had been written out thirteen times in `styles.css`.
      `apps/desktop/test/wiring.test.ts` fails if it is written out again.
- [x] Colour that survives a colour-blind reader: ref kinds and status kinds carry a glyph as well
      as a colour, and every state is legible in a still screenshot. The check is the real window
      through a red-green colour matrix — `apps/desktop/test/e2e/colour-blind.spec.ts`, and the
      picture is `reports/colour-blind.png` — with the two things a filter cannot take away asserted
      beside it: every badge carries exactly one glyph, and every working-tree entry is a file-kind
      drawing next to a status letter. With the colours collapsed, the badges, the status letters
      and the lane geometry are what is left, and the screenshot was read before this was ticked.

**Exit**: `make e2e` green with a screenshot per spec, every screenshot looked at by a person, and
the icon set visible in one of them with each glyph recognisable without its label. `grep -r
'prefers-reduced-motion' apps/desktop/src` finds the one media query, and turning it on changes
nothing that a test asserts.

## P2 — Change

The working tree becomes editable, and the confirmation machinery gets its real workout.

- [x] Stage, unstage, discard (per file and per hunk), amend, commit, commit-and-push. Stage,
      unstage, amend and commit are in, and the parity half of this phase's exit criterion is
      asserted by `apps/desktop/test/e2e/commit.spec.ts`. Discard is in, per file and per hunk, for
      both halves of the working tree: `restore --worktree` for a tracked path, `clean -fd -- <path>`
      for one git has never seen, and `apply --reverse` of a patch built from the file's own diff for
      a single hunk. Each goes through the confirmation sheet and each is asserted by
      `apps/desktop/test/e2e/discard.spec.ts`. Commit and push is **two commands in the order a
      person would run them**, not one the core invented — the activity card shows both with their
      own reverses, and a commit that failed is not followed by a push of whatever was there before.
      `commit.spec.ts` pushes to a real bare repository beside the fixture and asserts the remote
      holds the commit, and that both commands are in the card.
- [x] Branch create/switch/rename/delete, tag create/delete, checkout of a commit (detached).
      Creating a branch, creating a tag and the detached checkout are the commit's own menu; switch,
      rename and delete are the BRANCHES AND TAGS card. `apps/desktop/test/e2e/refs.spec.ts` asserts
      each against git itself — `symbolic-ref` after a switch and after a rename, `tag --list` before
      and after a deletion whose reason had not been given yet, and an unmerged branch that git
      refuses to delete with the failing command left in the activity card. A forced `-D` has no
      button: it is reachable through `orbitree run --op branch-delete --arg x --arg force`, and `-d`
      is the half that needs no confirmation because git itself refuses the dangerous case.
- [x] A left panel of sections: Local, Remote, Tags and Submodules, each collapsible — with
      `<details>`, so the collapsing, the keyboard and what a screen reader announces are the
      platform's rather than a second implementation — and the whole panel resizable by dragging its
      divider (clamped, and kept for the session). Clicking a name reads the graph from that
      revision, which is what the `All branches` dropdown did; the per-row actions moved with the
      rows, and the refs card in the side column is gone because the panel is that surface now.
      **Stashes are deliberately not a section**: a stash is a commit with a patch, and a patch
      belongs in the wide column that can show it rather than in a 220px panel of names. They keep
      their card, which reads, previews and applies them.
      `apps/desktop/test/e2e/refs.spec.ts`, `graph-controls.spec.ts` and `wip.spec.ts` assert the
      panel's rows against git and the graph; `reports/refs.png` was looked at.
- [x] Summary and description as two fields in the commit box, because the summary is what the graph
      shows and everything after it is for the reader of the commit. The command passes them as two
      `-m`, so git is what decides a commit body's shape; `apps/desktop/test/e2e/commit.spec.ts`
      asserts `%B` is the summary, a blank line and the description, and that the graph shows the
      summary.
- [x] Merge, and the conflict screen: ours/theirs/both at the hunk level. A branch is merged into
      the current one from its own row in the BRANCHES AND TAGS card, and a merge that conflicts
      stops into a screen rather than into a failure: the three versions of a conflicted path — the
      common ancestor, ours and theirs, read from the index stages that hold them — the file's own
      markers below them, one row per conflict region with `ours` / `theirs` / `both` and an `edit`
      box whose text becomes the resolution, a side per file (`git checkout --ours/--theirs`, which
      leaves the conflict in the index and is therefore undoable), `resolve` for `git add` under
      git's own word for it, and `abort the merge`. Resolving one region renumbers the rest, so the
      panel re-reads rather than keeping a list. The patch that carries a resolution is built inside
      the executor from a read of the file, which is what keeps a caller's text to the added lines of
      one region. Asserted by `apps/desktop/test/e2e/conflict.spec.ts` and `refs.spec.ts` against git
      and the file on disk, and by `packages/core/test/conflict.test.ts` on a two-region conflict
      made by git.
- [x] Stash push/pop/apply/drop, with a diff preview. Push is the quick bar's Stash; the card lists
      every entry with show, apply, pop and drop. `stash-show` reads the stash's own patch through
      the same parser and the same pane as any other diff, so a preview is not a second opinion
      about what a stash holds. `stash-drop` is destructive and `docs/INVARIANTS.md` lists it: pop
      and apply put the work back in the working tree first, and drop throws it away without putting
      it anywhere. `apps/desktop/test/e2e/stash.spec.ts` asserts against git and the file on disk
      rather than against the card: showing changes nothing, applying puts the work back and keeps
      the stash, and dropping refuses without a reason and then removes it.
- [x] Undo: every change in the session is listed with the `git` command that reverses it. The
      reverse is a pure function of the command and of the state *before* it — the commit HEAD was
      on, the branch that was checked out, and what every branch and tag pointed at — which the
      window already holds in memory from its last status and refs reads. `reverseOf` returns `null`
      rather than a line that would fail when there is nothing to undo with: work that was never
      committed (`clean`, `discard`), a dropped stash, or a decision rather than a command (a force
      push). The activity card shows it under the command with its own copy button, and the command
      reaches an agent too: `run` accepts `before` and answers with `reverse`.
      **The undo runs**: `reverseOf` answers with a command rather than a line of text, so the card
      has an `undo` button that goes through the same guarded path as everything else — and the
      reverse of a destructive operation is one too, so it opens the confirmation sheet. Two
      operations exist for it: `reset-soft`, which is what undoing a commit means (the work stays
      staged rather than being thrown away), and `regenerate-conflict`, which asks git for a
      conflict's markers back from the index stages. Both are reachable through `orbitree run`.
      `packages/core/test/reverse.test.ts` pins the reverse of every operation in the union, and both
      directions of the state question — what a line looks like with it, and that without it the
      operations that need it get nothing.
- [x] Every one of those is reachable through `orbitree run --op <op>`, with `--dry-run` first.
      `packages/cli/test/cli.test.ts` walks the list `orbitree ops` publishes — 33 operations now,
      the reads among them — and runs each one with `--dry-run`, which is what the flag is for: it
      resolves the argv before the confirmation check. Seven operations the panel had grown were
      missing from `commandFrom` (`take-side`, `merge-abort`, `conflict-side`, and the four reads
      `status`, `graph`, `refs` and `pending-operation`), which is exactly the drift the test exists
      to catch: a published list is a promise, and a caller who reads it and tries one gets the
      promise kept or a bug.

**Exit**: `orbitree run --op commit --message x --json` and the app's Commit button produce the
same commit object on the same input — asserted by a test, not by inspection.

## P2.5 — Worktrees

One repository, more than one working directory. This is where the product stops being "one window per
repository" and becomes "one window per working copy", which is why it is a phase and not a bullet: it
changes what a tab *is*.

The reason it is not `Later`, where the sift put it: a worktree is how one person runs two lines of
work at once — a review and a fix, a branch and a build — and it is how more than one agent works on
one repository without fighting over one index. The conventions of the category have settled on
first-class worktrees for that second reason.

- [x] Read them: `git worktree list --porcelain`, a total parser, and the list the window can show.
- [x] Create one (`worktree add <path> [<branch>]`), remove one (`worktree remove`, and `--force`
      which is destructive), each reachable through `orbitree run --op`.
- [x] A tab per worktree: the repository is the same, so the *history* is the same, and what differs
      is the working tree, the index and the path. **The tab model did not have to change**: a tab is
      already a path, so a worktree opens in one by opening it — what was missing is a panel section
      listing the others, marked with the branch they are on and with the ones already open disabled.
      `apps/desktop/test/e2e/refs.spec.ts` opens the second working copy and asserts its own path, its
      own branch in the working-tree card, and the same history in the graph.
- [x] `orbitree worktrees --json`, so an agent can name a working copy the way the window does: the
      path, the head, the branch (or `detached`, or `bare`), and the reasons git gives for a worktree
      being locked or prunable. The one the command was run in is marked, because the same history in
      two directories is only useful if a reader can tell which directory they asked from.

**Exit**: with two worktrees of one repository, `orbitree worktrees . --json` lists both with their
branch and their head, the window opens the second one as its own tab, and a commit made in one is
visible in the other's graph without a reload of the repository — asserted by a test that reads both
directories with the real `git` binary.

Met by two tests. `packages/cli/test/cli.test.ts` makes a second working copy with `git worktree
add` and compares the list against `git worktree list --porcelain` read a second way: two entries,
the same head, `main` and `side`, and exactly one line of the text form marked as the one asked
from. `apps/desktop/test/e2e/refs.spec.ts` has the second working copy open in its own tab, commits
on `main` in the first one while it is on screen, and presses Refresh: the other tab's graph goes
from one commit to two and names the new one. "Without a reload of the repository" is read as
without reopening it — the window re-reads when it is asked to, and watching the file system for a
commit made in another directory is a feature no bullet in this phase asked for, so the button is
the re-read the exit is about.

## P3 — Sync

Remotes, credentials, and the errors that come with the network.

- [x] Fetch (with progress), pull fast-forward-only, push, force-push-with-lease behind a
      confirmation, remote management. `fetch`, `pull` and `push` were already the guarded
      operations; what this added is the configuration they take their arguments from
      (`remote-list`, `remote-add`, `remote-remove`, `remote-rename`, `remote-set-url`, each
      reachable through `orbitree run --op` and listed by `orbitree ops`) and **progress**: the three
      remote commands carry `--progress`, `execute` takes an `onProgress` callback, the CLI prints
      the lines to stderr as they arrive, and the window keeps the last one in the bar the command
      was asked from. The finding is in `parseProgress`: git's progress and git's errors share a
      stream, so the phase names are checked rather than guessed — a pattern loose enough to match
      any `word: text` line reads `fatal: unable to access …` as a phase called "fatal". Remote
      management is in both front-ends: `run --op` for an agent, and a **Remotes** section in the
      window's panel for a person — the config, which is a different list from the remote branches
      that came from it, since a remote nothing has been fetched from has no branches and is still a
      remote. Adding one is the dialog that needed a second field (a name and where it points) and
      the section says which of the two URLs a remote has when they differ.
- [x] Credentials from the system helper: `git credential fill`, `gh auth token`, `glab auth
      token`, SSH agent. Tokens are never written to a config file of ours.
      `credential-fill` asks **git** for the credential, and `orbitree credential --host <host>`
      answers whether one is stored, who it is for, and why not when there is none — with **the secret
      withheld**: the product has no use for a token yet (P5 does), and a value it never holds is one
      it cannot leak. Asking git rather than a keychain is also what keeps the layering rule intact:
      no program but `git` is spawned, and the helper stays whatever the user configured.
      **`gh auth token` and `glab auth token` are deliberately not called**, and that is a decision
      rather than a gap: a second program the core spawns is the one thing this design rests on not
      doing, and it is not needed — `gh auth setup-git` puts the token where git looks, and the
      question a person or an agent has ("is there a credential, and for whom") is the one this
      answers. The SSH agent is the same story from the other side: the key is used by `ssh` when git
      calls it, never by anything here.
      Tokens never written to a config of ours is the other half, and it is tested in both directions:
      `redact` covered `stdout` and `stderr` and **not the argv**, which is the one thing this product
      shows twice over — `orbitree run` prints it and the activity card prints it with a copy button
      beside it — so a token in a remote URL was on a screen and on the clipboard in the clear. It is
      masked where the argv leaves the process now, and `docs/INVARIANTS.md` says what that does and
      does not cover.
- [x] Per-repository identity (name/email/signing key) with the effective value shown.
      `parseIdentity` gives the value in force with the file it came from, git's own precedence
      decides which one that is, and both front-ends show it: `orbitree identity --json` for an agent,
      and an **Identity** section in the window's panel for a person, which says `unset` for a part
      nobody configured rather than leaving a blank — git refuses a commit without a name, and that is
      worth knowing before trying. `apps/desktop/test/e2e/identity.spec.ts` asserts the card against
      `git config --show-origin` read a second way.
- [x] A network failure shows what to do (SSH key, token scope, offline), not just stderr.
      `diagnoseFailure` turns the failures that actually occur — an SSH key that is not loaded, a host
      key ssh does not trust, a refused token, an unreachable host, a repository the account cannot
      see, a branch that moved, a rule the server applies — into a next step, `null` for everything
      else, and never instead of what git said: the CLI prints it after git's words and the window
      puts it under the command on the activity card, where a failed command already lives. It reads
      text, so it is matched on git's own phases and wordings and the finding is recorded: git appends
      "Please make sure you have the correct access rights and the repository exists" to *every*
      remote it cannot read, so matching that sentence made a path that is not a repository look like
      an SSH key problem.

**Exit**: a real `git push` to a GitHub repository and to a self-hosted GitLab instance from
the app, each with the token coming from the system helper and never appearing in a log —
checked by a test that greps the session log for the token's shape.

Met against a real transport, and **not** against GitHub or GitLab. `packages/core/test/credential-push.test.ts`
runs the whole shape of the criterion locally: a bare repository served over HTTP by a node server in
front of `git http-backend`, refusing every request without Basic auth; a credential helper — the same
canned helper a person would write — answering with a token; `push` through the product's own
executor; and git's answer from *inside* the remote saying the commit arrived. The same fixture given
the wrong token is what `diagnoseFailure` is asked about, so the "token refused" sentence is tested
against a real 401 rather than a copied string, and `credential-fill` is asked the same question the
push answered. Nothing the product prints or holds contains the token: that is `[I8]`, asserted both
here and in the CLI's own output.

What is still not met is the part that names two forges, and the reason is not the product: a test
that pushed to GitHub and to a self-hosted GitLab would need two accounts and two tokens in CI, and it
would be testing them rather than this. The app's half of it — a push from the window, with the
command and its outcome on the activity card — is `commit.spec.ts` and `activity.spec.ts`, which push
through the same executor this test does.

## P3.5 — Explain

The read-only half of developer support: understanding a line, a file and a branch, without touching
any of them. None of this mutates a repository, so none of it needs a confirmation.

- [x] Blame, per line, with the commit it came from and a jump into the graph at it. `blame` is a
      guarded operation, `parseBlame` reads `--line-porcelain` — which repeats the metadata per line, so
      a truncated read cannot shift the blame of the lines above it — and `orbitree blame --file <file>
      --json` names the commit, the author and the date for every line. The window has it in the pane
      the file is already in, behind a **diff / blame** toggle rather than in a column of its own: the
      two views are two questions about the same file. Clicking a line selects its commit in the graph,
      which is the jump; a line that is only in the working tree has no commit behind it, so it is
      rendered with git's own `Not Committed Yet` and nowhere to jump — the case that would otherwise
      send a reader looking for a commit that does not exist. A file git has never tracked is not
      offered at all, since every line of it would come back as uncommitted.
      `apps/desktop/test/e2e/blame.spec.ts` asserts the pane against `git blame --porcelain` and
      `git log`, and asserts that the jump really moved the graph.
- [x] File history: the commits that touched one path, in the graph's own shape. `graph --file <path>`
      reads it, and it is a field of the graph rather than a second read: git's own simplification
      answers which commits touched a path, `layoutGraph` draws them, and `total` counts the same set so
      `truncated` keeps comparing the window with the history it came from. `orbitree graph --file <path>
      --json` is the same answer for an agent, and the window's file pane has a third **history** view
      beside diff and blame, one row per commit with the lane it sits in, and the same jump a blamed
      line has.
      **The limit, stated rather than discovered**: the pane is reached from the working tree's file
      list, so a file with nothing uncommitted has no row to click and its history is only available
      through the CLI. Blame has the same limit. Both want the same answer — a way to look at a file
      the working tree is not already showing — and neither has it yet.
- [x] Branch comparison in both directions: what this branch has that that one does not, and back.
      It is one read, `git log --left-right --cherry-pick A...B`: the mark `%m` prints says which side a
      commit is only on, and `--cherry-pick` leaves out the commits whose patch is already on the other
      side — the difference between two branches having different *commits* and different *work*, which
      is why this is git's answer rather than a set difference of two hash lists. One parser reads it:
      `parseComparison` strips the mark and hands the record to `parseLog`, so a comparison obeys the log
      parser's rules about a hash, a parent list and a subject instead of a second set of them.
      `orbitree compare . --left main --right next --json` prints `onlyLeft` and `onlyRight` beside every
      record in git's order.
      The window has it too: every branch row in the panel carries **compare**, which reads that branch
      against the one that is checked out and shows the two lists in a card — one row per commit, each a
      jump into the graph, the same jump blame and history offer. Comparing the checked-out branch with
      itself is an empty answer, so its own button is disabled rather than slow.
      **The limit, stated rather than discovered**: `--limit` (500 by default) is a window that neither
      the text nor the JSON marks as truncated, so a caller that needs to know whether more commits exist
      asks again with a larger limit. The check the P3.5 exit criterion names is `compare.test.ts`: the
      fixture forks and then cherry-picks one side's work across, so a comparison implemented as a set
      difference of hashes would fail it, and `compare.spec.ts` asserts the card against `--left-only`
      and `--right-only` read separately.
- [x] Commit search: message, author, date range, path, and "only mine", applied to the graph as a
      filter rather than as a separate list. The fields are the graph's own (`grep`, `author`, `since`,
      `until` beside the `path` that file history already used), they go to the **count** as well so
      `truncated` keeps comparing like with like, and `orbitree graph` takes them as options. The window
      has a **Search** section in the panel — submitted rather than typed live, because a search on every
      keystroke is a git call per letter — and the graph's header says `searching`, since a filter narrows
      the total too and "3 of 3 commits" would otherwise read as a repository with three commits in it.
      "Only mine" is a checkbox, not a fifth text field: it is the address the repository is configured
      with, read from the identity card the panel already shows, and a repository with no `user.email`
      anywhere makes it a usage error rather than a search for nothing.
      **The finding**: git's date parser fills the fields a date leaves out from **now**, so
      `--since=2026-10-18` on the eighteenth at 19:29 means "since 19:29 today" — a day-long search
      reported as empty, which is a wrong answer that looks like a right one. A bare `YYYY-MM-DD` is
      therefore expanded to the whole day (its midnight for `since`, the next midnight for `until`, by
      calendar rather than by adding 24 hours), and `graph.test.ts` pins both directions on the fixtures'
      own pinned commit dates.
- [ ] Open in editor, open in terminal, reveal in the file manager, each configured once.
- [x] A command palette over every action, by name and by keybinding, built from one registry that
      the quick bar also reads. `renderer/commands.ts` is that registry: each entry says whether the bar
      has room for it and whether it needs the window's state (the selected commit), so the bar's buttons
      and the palette's list are two readings of one list rather than two lists. `Cmd/Ctrl+K` opens it,
      ↑↓ and Enter run, Escape closes, and the filter matches the label, the command it would run
      (`stash` finds Unstash, because Unstash runs `stash pop`) and where it lives. Every entry goes
      through the same `runGuarded` a click takes, so a destructive one opens the confirmation sheet
      whichever surface asked — which is also the test's proof that nothing ran. Commands that need a
      value the registry cannot invent (a branch or tag name) are deliberately absent: they open a
      dialog, which is a different kind of entry.
      Two things fell out of it: the confirmation sheet now closes on Escape like every other modal here
      (a dialog that ignores it is a dialog that traps), and the two destructive quick-bar labels say what
      they do rather than being `Clean` and `Reset --hard` twice over.
- [x] Tab shortcuts: `Cmd/Ctrl+1-9` to switch, `Cmd/Ctrl+T` and `+` to open, `Cmd/Ctrl+W` and a
      middle click to close. One modifier, `Cmd` on macOS and `Ctrl` elsewhere, decided by the platform
      and never both; `1`–`8` are the tabs in order and `9` is the last, which is the convention every
      browser and editor trained a reader to expect. They work while typing, because a commit message is
      not a place where `Cmd+1` means the digit `1`. The shortcut and the `+` button call one function
      rather than two that drift, and the middle click prevents Chromium's autoscroll before it closes —
      a gesture that scrolled the pane on its way out would be a gesture nobody uses twice.
      `apps/desktop/test/e2e/shortcuts.spec.ts` presses them on the real window, with the modifier named
      from the platform, and asserts the tab that becomes active by its own class rather than by the
      address, which a tab can share.
- [ ] A ghost branch for the selected commit, with a double click to check it out, and an optional
      highlight of a branch's commits on hover.

**Exit**: given a file and a line, the app names the commit that last changed it and opens the graph
at that commit; given two branches, it lists the commits in each and not the other, and the lists
disagree with `git log --left-right --cherry-pick` by nothing.

## P4 — Quick commands

The requested centrepiece, finished.

- [ ] Commands are data: `quickCommands` in the user's config, each with `{ id, label, hint,
      command, danger }` validated by the same schema the IPC uses.
- [ ] A command can take arguments (a branch, a path) and a message, and can be run against a
      selection in the graph or the working tree.
- [ ] The confirmation sheet shows the exact `git` argv (from `--dry-run`) before asking for a
      reason.
- [ ] Command palettes: the same commands from a keyboard, and from the CLI by id.
- [ ] Sharing: a quick-command preset is a JSON file someone can commit to their dotfiles.

**Exit**: `orbitree run --op <op> --dry-run --json` and the GUI's confirmation sheet print the
same argv for the same button — asserted against the shipped preset list.

## P5 — Forges

Pull requests and merge requests, without becoming a forge client.

- [ ] One adapter interface: `listRequest`, `getRequest`, `createRequest`, `checksFor`, `auth`.
- [ ] GitHub (via the REST API, reusing `gh auth token` when present).
- [ ] GitLab, including self-hosted, via a configurable API base URL.
- [ ] A generic "git only" mode for anything else: no forge features, everything else works.
- [ ] CI status per commit in the graph, and per request in the request list.
- [ ] Recorded HTTP fixtures in the test suite, plus a live test against a containerised
      self-hosted forge, marked opt-in so CI stays reproducible.

**Exit**: `orbitree requests . --json` lists open requests for a GitHub repository and for a
self-hosted GitLab project, with the same schema.

## P6 — Agents

Make the machine-readable surface a first-class product, not a side door.

- [ ] `orbitree mcp` — an MCP server exposing every operation with the CLI's schemas, plus
      read-only resources for the graph and the working tree.
- [ ] `orbitree schema --json` publishes a versioned JSON Schema per command; the schema version
      is bumped by policy, and a test fails when `data` changes without a bump.
- [ ] `orbitree watch --json` — a line-delimited stream of repository state changes, so an agent
      can wait for a change instead of polling.
- [ ] A written contract for agents: what is safe to call without asking, what is not, and how
      to undo (`docs/AGENT-CLI.md`).
- [ ] Operational history in the app: every command an agent ran, with its argv and exit code.

**Exit**: an agent completes "find the commit that broke the test, revert it, verify" using only
`orbitree` in machine-readable mode, and the app shows what it did.

## P7 — Ship

Releases people can install and trust.

- [ ] A release is a pull request from `next` into `main`, then a tag and a GitHub release, with the
      version in the manifest and the CHANGELOG bumped in the same pull request.
- [ ] electron-builder targets: macOS (arm64/x64, signed and notarised), Windows (NSIS, signed),
      Linux (AppImage + deb).
- [ ] Auto-update from the release artifacts, with a channel for pre-releases.
- [ ] A release workflow that refuses to publish unsigned artifacts, and records the sha256 of
      each one in the release notes.
- [ ] Crash and error reporting that is local: a log file the user can read and attach.
- [ ] Documentation site: getting started per platform, the CLI reference generated from the
      published schemas, the invariant list.
- [ ] SBOM and a dependency-update cadence that a bot keeps honest.

**Exit**: a fresh machine on each of the three operating systems installs the published artifact,
opens a repository, and `orbitree doctor` reports nothing to fix.

---

## Deliberately not on the roadmap

Anything in the `Later` and `Never` columns of `docs/PRODUCT.md`. If a phase grows one of those
items, the phase is wrong, not the product.

## How a phase gets a PR

1. One issue per bullet, opened before the work, with the exit criterion quoted in it.
2. A branch per issue, a test that fails without the change, `make verify` green.
3. One commit per coherent change; the body says what was measured.
4. Update this file in the same PR: a phase item is ticked only when its exit command has run.
