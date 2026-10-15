# Design

What this product looks like, why, and what is deliberately left out. `docs/PRODUCT.md` holds the
feature sift; this file holds the surface: the icon set, motion, density, and the developer-support
features that earn their place in a Git client.

The reference point is the *category*: dense commercial Git clients that put the graph in the middle
of the window, the working tree beside it, and a toolbar of one-click actions above both. Their
conventions are the conventions people arrive with, so we follow the ones that carry meaning and
leave the ones that are decoration. Nothing here is a copy of a specific product, and no other
product is named anywhere in this repository.

## The shape of the window

| Region | Holds | Rule |
|---|---|---|
| Top bar | brand, path, Browse, Open | one row, never taller |
| Tab bar | one tab per repository, plus `+` | a tab is a *reading*, not a path, so two tabs on one repository are legitimate |
| Quick bar | the commands reached for most | icons plus a word, never icon-only |
| Graph pane | the commit list, lanes, ref badges, controls | the widest region, because it is the product |
| Side pane | commit detail, working tree, stashes, activity | a scrolling column of cards, in that order |

Density is a feature at this size: `ROW_HEIGHT` in the graph and the row metrics in the panes are
declared once, and everything aligns to them. A client that shows 12 commits per screen is a client
that makes you scroll for a branch boundary you would have seen. The monospace face is one custom
property, `--mono`, for the same reason: a hash and a path have to line up in a column, and a face
written out in thirteen rules is a face that drifts.

## Icons

An icon earns its place when it is recognised without a legend and when it replaces a word that is
repeated a hundred times: an action, a file kind, a ref kind, a status code. An icon does not earn
its place where a word is unambiguous and used once.

**Where icons go**

| Surface | Icon | Notes |
|---|---|---|
| Quick bar | per command, with the label beside it | an icon-only toolbar is a memory test |
| File kind | by extension, one glyph per family | replaces the `=`, `#`, `{}`, `~` placeholders the working tree uses today |
| Ref badges | branch, remote, tag, HEAD | colour already distinguishes them; the glyph makes it survive colour blindness |
| Status code | modified, added, deleted, renamed, unmerged | the letters stay: git's own codes are the vocabulary |
| Tabs | close, and the repository's own mark | |
| Panes | a heading glyph per card | small, dim, decorative |

**How they are built.** Inline SVG components on a 24px grid with a 1.5px stroke, sized 14 or 16px,
`stroke="currentColor"` so the theme is the only source of colour, and `aria-hidden` unless the icon
is the only content of its control. They live in `apps/desktop/src/renderer/icons.tsx` as one
component per glyph, so the bundler keeps only the ones that are used.

The alternative — a dependency such as `lucide-react` or an icon font — is one line of install and
about 1500 glyphs nobody asked for, plus a font file that renders differently on each platform. The
set this product needs is on the order of twenty glyphs, and drawing them is cheaper than auditing a
dependency's licence, tree-shaking and accessibility for one icon. Revisit if the count passes about
forty.

**The test.** A screenshot with every icon visible can be read by a person who has not seen the app
before, and the meaning survives being printed in a single colour. `apps/desktop/test/e2e/icons.spec.tsx`
draws it: it renders whatever `icons.tsx` exports, at the two sizes the product uses, so a new glyph
appears in the gallery without anybody remembering to put it there, and it fails on the two mistakes
a picture cannot show — a glyph that draws nothing, and two glyphs that draw the same shape under
different names. It found the second: the stashes card and the stash command had a glyph each, drawn
differently and read as the same box at 14px. There is one now.

**Two rules learned by getting them wrong.**

A mark drawn inside a silhouette must dominate it. The eight file glyphs were built on one shared
page outline with the family mark in the lower half, and the mark came out about seven units in a
thirteen-by-eighteen page: at 14px, four pixels with a sub-pixel stroke. Five different file kinds
read as the same sheet of paper, which was worse than the text glyphs they replaced, because those
at least differed. The mark is now scaled to about eleven units about its own centre, with
`vector-effect="non-scaling-stroke"` so it stays the same weight as the outline, and the file column
draws at 16px rather than 14.

Colour is a second channel and never the only one. A file kind carries a colour so a column of
twenty rows can be scanned, and the mark, the test id and the name still differ, so a reader who
cannot tell two of the colours apart loses nothing. This is the same rule the status codes and the
ref badges follow.

The general form: **judge an icon at the size it is used, in the app, in a screenshot.** Every one of
these was invisible in a diff and obvious in the window.

## Motion

Motion in a Git client is a hint about what just changed, and nothing else. It never carries
meaning on its own, because the window is also read in a screenshot, in a test and by somebody who
turned animation off.

**Rules, in order of precedence**

1. **A state must be legible in a still image.** If a transition is the only way to see that a
   commit landed or a file was staged, the transition is hiding a missing label. This is not a
   principle, it is a test constraint: every E2E spec here asserts against a screenshot.
2. **`prefers-reduced-motion: reduce` removes every transition and every animation.** Not shortened,
   removed. One media query at the bottom of the stylesheet, and no exception.
3. **Nothing animates the graph.** Lanes shift when the history is re-read, and a sliding lane is a
   lie about where a commit is. The graph appears with its content or not at all.
4. **Nothing delays input.** A keystroke, a click and a scroll are acknowledged in the same frame.
5. **Entering moves, leaving does not.** A panel fades and rises 2px over 160ms; it disappears at
   once. Leaving is not worth waiting for.
6. **No loops, no shimmer, no skeletons, no bouncing.** The only infinite animation in the product
   is the tray icon's spinner, and only while a remote operation is genuinely in flight.

| Duration | Use |
|---|---|
| 90–120ms | hover, focus ring, a button's pressed state |
| 160ms | a panel or a card entering, a row's selection background |
| 200–240ms | a whole-pane change, and only when the pane is empty first |

Easing is `ease-out` for anything entering, `ease-in-out` for a state change in place. Colours
interpolate; sizes and positions do not, with the two exceptions above.

## Developer support

What a person actually does with a Git client in a working day, and what this product owes them.
`Must` is the visual phase and P2, `Should` is a phase of its own, `Later` is unbuilt until asked.

| Feature | Verdict | Why |
|---|---|---|
| **The command behind every action.** Each entry in the activity log expands to the exact `git` argv, with a copy button | **Must** | it is the product's thesis made visible: the window and the CLI are the same program, and a client that shows its work teaches git instead of hiding it |
| A conflict editor at hunk level: ours, theirs, both, and an editable result | **Must** | this is where people give up and open a terminal |
| Interactive rebase as a plan: reorder, squash, fixup, reword, drop, then apply | **Should** | high value and high risk; it must be a plan that can be reviewed before it runs |
| Undo, backed by the operation log and the reflog | **Should** | the answer to "which command reverses that", for a person and for an agent |
| Blame and file history | **Should** | needed to understand a line, not to change one |
| Branch comparison: what is in this branch and not in that one, both directions | **Should** | the question behind half of all merges |
| Commit search: by message, author, date, path, and "only my commits" | **Should** | a graph you cannot query is a graph you scroll |
| Open in editor, open in terminal, reveal in file manager | **Should** | every one of them is one line and saves a switch |
| A command palette over every action, by name and by keybinding | **Should** | the answer to a toolbar that cannot hold everything |
| A dashboard across the open repositories: dirty, ahead, behind | **Later** | worth it at four repositories, useless at one |
| Per-repository identity: name, email, signing key | **Later** | matters at work, never on the first run |
| Cherry-pick and revert with a target picker | **Later** | the graph already answers "from which commit" |
| Git hooks editor, worktrees, submodules as first-class citizens | **Later** | real, and each is a phase of its own |
| A built-in terminal | **Never** | the user has one, and it is better |
| An embedded editor for source files | **Never** | the same answer, and a second product to maintain |
| Rewriting history without a reviewable plan | **Never** | the difference between a tool and a foot-gun |
| Gamified streaks, badges, "contribution" decorations | **Never** | nothing about a version control client is a game |

**The one that is not like the others.** "The command behind every action" is the cheapest of these
and the most defensible: the argv already exists in the core, the activity log already records the
result, and showing the command turns every click into a `git` lesson. It is in the visual phase
because it is a surface, not a feature.

## Measured against the category

The conventions below are the ones a person arrives with, read from the documentation of the dense
commercial clients this product is measured against. They are the *category's* conventions, not one
product's: where we follow, we follow the convention, and where we differ we say why.

### The window, as the category arranges it

| Region | The convention | Ours | Verdict |
|---|---|---|---|
| Toolbar | Undo, Redo, Pull (with a behaviour dropdown), Push, Branch, Stash, Pop; labels toggleable | Fetch, Pull, Push, Stash, Unstash, and two destructive commands | **differ**: destructive commands belong in a context menu, not one stray click away; and undo is missing, which is the bigger gap |
| Left panel | Local, Remote, Pull Requests, Issues, Teams, Tags, Stashes, Submodules, sections collapsible, resizable, maximizable by double-click | a single `All branches` dropdown and a right-hand side pane | **follow, and it is the largest structural gap**: refs need a panel of their own, with sections |
| Centre | the commit graph, with a WIP node for the working tree and nodes for stashes | the graph, no WIP node | **follow**: the WIP node is a good idea and it is one row |
| Right | a Commit Panel that shows the selection's files and diff, or the working tree, and stages inside it | a side pane of four cards: commit, working tree, stashes, activity | **partly follow**: the panel's job is the selection; splitting it into cards is our own choice and it costs vertical space |
| Columns in the graph | Branch/Tag, Graph, Message, plus optional Author, Date, Sha; reorderable, resizable, toggleable from a header menu, remembered per repository | fixed: badges, graph, subject, author, short hash | **later**: the conventions are worth having and not worth building before the graph is denser |
| Tabs | Cmd/Ctrl+1-9, +/Cmd+T, middle-click and Cmd/Ctrl+W to close, drag to rearrange, right-click to alias | click to switch, × to close, + to open | **should**: the shortcuts are cheap and the keyboard is how a client stops being slow |
| Status bar | launchpad summary, plan, zoom selector | nothing | **differ**: no plan, no launchpad, and no status bar until there is something to put in it |
| Command palette | Cmd/Ctrl+P over commands, files, repositories, settings | planned in P3.5 | **follow** |

### Behaviours in the graph worth copying

- **A ghost branch.** Hovering or selecting a commit shows the nearest branch that contains it, and
  double-clicking checks out that branch's head. It answers "where am I in relation to this commit"
  without a second view. **Should.**
- **Highlighting a branch on hover**, fading the commits it does not contain. **Later**, behind a
  setting: fading is a strong gesture and it is disorienting the first time.
- **A WIP node at the top of the graph**, with the stash nodes among the ordinary ones. It makes
  "not committed yet" a place in the same picture as everything else, which is the same argument
  this product already makes for detached heads and stopped merges. **Must.**
- **A commit's context menu**, holding the actions that act on a commit: create a branch here, create
  a tag here, check out, reset to here, copy the sha, copy the message. **Must**, and it is the
  answer to a toolbar that cannot hold everything.
- **Column headers with a menu**, so Author, Date and Sha are choices rather than decisions made for
  the reader. **Later.**

### The features the category treats as table stakes

| Feature | Ours | Where |
|---|---|---|
| Undo/redo as toolbar buttons, driven by the operation log | missing | P2, already listed as "every change in the session is listed with the `git` command that reverses it" |
| A configurable pull behaviour with a remembered default | hardcoded `--ff-only` | P3; the safe default stays the default, and it becomes a choice |
| Summary and description as two fields | one textarea | P2, small and worth it: the summary is what the graph shows |
| Staging inside the selection's panel | staging in its own card | P2, when the panel is reworked |
| Repository aliases, tab reordering, drag and drop | none | Later |
| Profiles that switch identity and tabs together | none | Later, next to the per-repository identity already listed |
| A terminal | none | **Never**: the user has one, and it is better |

## How any of this is judged

`make e2e` drives the real window and writes a screenshot per spec. A design change is accepted when
the screenshot has been looked at, not when the test is green: a green test proves the assertion,
and the assertion is only ever as good as the number of things a person would have noticed. Every
rule in this file that could be broken silently has a test or a media query behind it, and the ones
that cannot are written here so that a reviewer can.
