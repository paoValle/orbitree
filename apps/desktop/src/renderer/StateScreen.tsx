/**
 * Where a repository is, drawn as a place rather than as a failure.
 *
 * An empty repository, a detached head, a stopped merge, a stuck cherry-pick and an
 * interrupted rebase are not errors: `git` did exactly what it was asked to. What used to
 * reach the screen was `git exited with 128`, which named a process status instead of a
 * state and told the reader nothing they could act on.
 *
 * Every state gets the same three parts — a title, what is true right now, and what the
 * reader can do next — because a screen that only says "something is wrong" is a fallback
 * with a nicer font.
 */
export type ScreenState = 'unborn' | 'detached' | 'merge' | 'cherry-pick' | 'rebase' | 'gone';

interface ScreenCopy {
  readonly title: string;
  /** `{detail}` is replaced by the one thing git named, when it named one. */
  readonly truth: string;
  readonly next: string;
}

const SCREEN_COPY: Readonly<Record<ScreenState, ScreenCopy>> = {
  gone: {
    title: 'Repository not found',
    truth: 'There is nothing at {detail} any more, so there is nothing to read from it.',
    next:
      'It stays in the recents list in case a volume is not mounted yet. The app will not reopen ' +
      'it by itself; open it again from the recents once it is back, or choose another directory.',
  },
  unborn: {
    title: 'No commits yet',
    truth: 'This repository has no commits: HEAD points at a branch that does not exist yet.',
    next:
      'The working tree beside this already works and can be read now. The first commit is a ' +
      'CLI operation for now: `orbitree run --op commit --message …`.',
  },
  detached: {
    title: 'Detached HEAD',
    truth: 'The working copy is at one commit, {detail}, which is not the tip of any branch.',
    next: 'Switching back to a branch is a P2 action; the history below is the real history and reads normally.',
  },
  merge: {
    title: 'Merge in progress',
    truth: 'A merge has stopped and is waiting: the files listed below are still in conflict.',
    next:
      'Open a conflicted file to see the three versions git is holding; take a side or edit the ' +
      'result, mark it resolved, and commit to finish — or give the merge up from the same screen.',
  },
  'cherry-pick': {
    title: 'Cherry-pick in progress',
    truth:
      'A cherry-pick has stopped and is waiting: the files listed below are still in conflict.',
    next:
      'Resolve each conflicted file in the working tree below; finishing or aborting the ' +
      'cherry-pick is a CLI operation for now.',
  },
  rebase: {
    title: 'Rebase in progress',
    truth: 'A rebase has stopped and is waiting: the files listed below are still in conflict.',
    next:
      'Resolve each conflicted file in the working tree below; finishing or aborting the rebase ' +
      'is a CLI operation for now.',
  },
};

export interface StateScreenProps {
  readonly state: ScreenState;
  /** The one thing git named: a short oid for a detached head, a branch for an unborn one. */
  readonly detail?: string | undefined;
  /**
   * A banner is attached to something real that is still on screen — the graph — so it stays
   * compact. A screen has nothing else to say, so it can take the space.
   */
  readonly variant?: 'screen' | 'banner';
}

export function StateScreen({
  state,
  detail,
  variant = 'screen',
}: StateScreenProps): React.ReactElement {
  const copy = SCREEN_COPY[state];
  const truth = detail === undefined ? copy.truth : copy.truth.replace('{detail}', detail);
  return (
    <section
      className="state-screen"
      data-testid="state-screen"
      data-state={state}
      data-variant={variant}
    >
      <h2>{copy.title}</h2>
      <p>{truth}</p>
      <p className="state-next">{copy.next}</p>
    </section>
  );
}
