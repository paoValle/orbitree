import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { GraphData, WorkingTreeNode } from '../shared/api.ts';
import { BranchIcon, HeadIcon, type IconProps, RemoteIcon, StashIcon, TagIcon } from './icons.tsx';

/**
 * The row metrics, declared once and used by both the canvas and the rows: a canvas drawn at a
 * height the DOM rows do not share is a picture that drifts from the list it labels.
 *
 * 26px fits a 12px subject line with its ref badges beside it, and about twenty rows — a branch
 * boundary among them — in the graph pane of the default window.
 */
export const ROW_HEIGHT = 26;
export const LANE_WIDTH = 16;
export const TEXT_GUTTER = 12;

/** Rows drawn above and below the viewport so a fast scroll does not show a blank band. */
const OVERSCAN = 4;

const LANE_COLORS = [
  '#6aa9ff',
  '#8bd5a0',
  '#f0a35e',
  '#c792ea',
  '#e57ba0',
  '#63d6d6',
  '#d5c46b',
  '#9aa7ff',
];

export function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length] as string;
}

export interface CommitTarget {
  readonly hash: string;
  readonly subject: string;
}

/**
 * The actions that act on a single commit. The list is closed because it is the set a
 * toolbar cannot hold: branch, tag, checkout, reset and the copies describe one row.
 */
export type CommitAction =
  | 'create-branch'
  | 'create-tag'
  | 'checkout'
  | 'reset-hard'
  | 'copy-sha'
  | 'copy-short-sha'
  | 'copy-message';

interface CommitMenuItem {
  readonly action: CommitAction;
  readonly label: string;
  /** Destructive, and drawn like the quick bar draws its own: red, before it is too late. */
  readonly danger?: boolean;
}

const COMMIT_MENU_ITEMS: readonly CommitMenuItem[] = [
  { action: 'create-branch', label: 'Create branch here…' },
  { action: 'create-tag', label: 'Create tag here…' },
  { action: 'checkout', label: 'Check out this commit' },
  { action: 'reset-hard', label: 'Reset --hard to here…', danger: true },
  { action: 'copy-sha', label: 'Copy commit SHA' },
  { action: 'copy-short-sha', label: 'Copy short SHA' },
  { action: 'copy-message', label: 'Copy message' },
];

/** The glyph a ref badge carries: HEAD is a pin, everything else is its ref kind. */
const REF_ICONS: Readonly<Record<string, (props: IconProps) => React.ReactElement>> = {
  branch: BranchIcon,
  remote: RemoteIcon,
  tag: TagIcon,
  other: BranchIcon,
  // A stash is not a ref the product lists, but a row that is one carries a badge like any other.
  stash: StashIcon,
};

function RefIcon({ kind, isHead }: { readonly kind: string; readonly isHead: boolean }) {
  const Glyph = isHead ? HeadIcon : (REF_ICONS[kind] ?? BranchIcon);
  return <Glyph size={11} />;
}

/** The header always says which window of the history is on screen: `300 of 2054 commits`. */
function describeWindow(graph: GraphData, laneCount: number): string {
  const commits = `${graph.commits.length} of ${graph.total} commits`;
  return `${commits} · ${laneCount} lane${laneCount === 1 ? '' : 's'}`;
}

/** What the working tree has waiting, in the working-tree card's own words. */
function describeNode(wip: WorkingTreeNode): string {
  const waiting = [
    wip.staged === 0 ? null : `${wip.staged} staged`,
    wip.unstaged === 0 ? null : `${wip.unstaged} changed`,
    wip.conflicted === 0 ? null : `${wip.conflicted} conflicted`,
    wip.untracked === 0 ? null : `${wip.untracked} untracked`,
  ].filter((part) => part !== null);
  return waiting.length === 0 ? 'clean' : waiting.join(' · ');
}

export interface GraphPaneProps {
  readonly graph: GraphData;
  readonly selected: string | null;
  readonly onSelect: (hash: string) => void;
  /**
   * `*` reads every ref; anything else is the revision the graph is read from.
   *
   * The choice is made in the left panel now, so this is what the header says rather than
   * something the pane edits.
   */
  readonly filter: string;
  /**
   * Whether the picture is a search of the history rather than all of it.
   *
   * The header has to say so: a search narrows the count *and* the total, so "3 of 3 commits" would
   * otherwise read as a repository with three commits in it.
   */
  readonly searching: boolean;
  /** One page of history; the load-more button asks for one more. */
  readonly pageSize: number;
  readonly onLoadMore: () => void;
  /**
   * Reports the chosen action so the app can run it through its one command path; the app
   * owns the clipboard writes too, in the same place that reaches git.
   */
  readonly onCommitAction: (action: CommitAction, commit: CommitTarget) => void;
  /**
   * What the working-tree node does when it is clicked.
   *
   * In a layout where the staging area is a contextual panel, the node switches that panel to it; in
   * this one the working tree is always on screen, so the only thing left to do is point at it.
   */
  readonly onWipClick?: () => void;
}

/**
 * The picture the product exists for, and the only place that knows how tall a row is.
 *
 * The canvas is one element for the whole history, but only the rows in the visible window
 * are drawn onto it and only those rows exist in the DOM. Rendering all of a large history
 * is what makes a graph client feel heavy, so the window is the design, not an optimisation.
 * Keyboard selection lives on the scroll container so arrow keys work while the list has
 * focus, and the selected row is scrolled back into view by arithmetic, not by `scrollIntoView`
 * (which would also move the other panes).
 */
export function GraphPane({
  graph,
  selected,
  onSelect,
  filter,
  searching,
  pageSize,
  onLoadMore,
  onCommitAction,
  onWipClick,
}: GraphPaneProps): React.ReactElement {
  const rows = graph.layout.rows;
  const edges = graph.layout.edges;
  const laneCount = graph.layout.laneCount;
  // The working tree is the row above the first commit, in the lane of the commit HEAD sits on,
  // and it is drawn only when that commit is in the window: a history filtered to another branch
  // is a picture of that branch, and a node joined to nothing would misstate where it sits.
  const headRow = useMemo(
    () => (graph.wip.on === null ? -1 : rows.findIndex((row) => row.commit.hash === graph.wip.on)),
    [rows, graph.wip.on],
  );
  const wipShown = headRow >= 0;
  const headLane = wipShown ? (rows[headRow]?.lane ?? 0) : 0;
  /** Every pane row below the node is the layout's own row shifted down by one. */
  const offset = wipShown ? 1 : 0;
  const commitCount = rows.length;
  const total = commitCount + offset;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const previousFilter = useRef(filter);
  const [viewportHeight, setViewportHeight] = useState(0);

  // One menu at a time, anchored where it was opened. The pointer position is kept unclamped
  // until the layout effect has measured the menu, so the clamp uses the menu's real size.
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLElement | null>(null);
  const menuItemsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const [menu, setMenu] = useState<
    (CommitTarget & { readonly x: number; readonly y: number }) | null
  >(null);
  const [menuAt, setMenuAt] = useState<{ readonly left: number; readonly top: number } | null>(
    null,
  );
  const [focusedItem, setFocusedItem] = useState(0);

  const openMenu = useCallback(
    (target: CommitTarget, x: number, y: number, trigger: HTMLElement) => {
      menuTriggerRef.current = trigger;
      setFocusedItem(0);
      setMenuAt(null);
      setMenu({ ...target, x, y });
    },
    [],
  );

  const closeMenu = useCallback((returnFocus: boolean) => {
    setMenu(null);
    setMenuAt(null);
    const trigger = menuTriggerRef.current;
    if (returnFocus && trigger?.isConnected) trigger.focus();
  }, []);

  useEffect(() => {
    if (menu === null) return;
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current !== null && !menuRef.current.contains(event.target as Node)) {
        closeMenu(false);
      }
    };
    // A menu that stays put while its row scrolls away is a menu about the wrong commit.
    const onViewportChange = () => closeMenu(false);
    document.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('scroll', onViewportChange, true);
      window.removeEventListener('resize', onViewportChange);
    };
  }, [menu, closeMenu]);

  useLayoutEffect(() => {
    if (menu === null) return;
    const element = menuRef.current;
    if (element === null) return;
    const { width, height } = element.getBoundingClientRect();
    const margin = 8;
    setMenuAt({
      left: Math.max(margin, Math.min(menu.x, window.innerWidth - width - margin)),
      top: Math.max(margin, Math.min(menu.y, window.innerHeight - height - margin)),
    });
  }, [menu]);

  useEffect(() => {
    if (menu === null) return;
    menuItemsRef.current[focusedItem]?.focus();
  }, [menu, focusedItem]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    const count = COMMIT_MENU_ITEMS.length;
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = (focusedItem + 1) % count;
    else if (event.key === 'ArrowUp') next = (focusedItem - 1 + count) % count;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = count - 1;
    if (next === null) return;
    event.preventDefault();
    setFocusedItem(next);
  };

  const activateMenuItem = (action: CommitAction): void => {
    if (menu === null) return;
    closeMenu(true);
    onCommitAction(action, { hash: menu.hash, subject: menu.subject });
  };

  /**
   * When the history being read changes, the reader's place is the graph.
   *
   * The choice is made in the left panel now, so the focus has to be moved here on purpose: the
   * arrow keys should walk the history that was just asked for, not the list of names it was asked
   * from. Only on a change, so the first render does not take focus from whatever else wants it.
   */
  useEffect(() => {
    if (previousFilter.current === filter) return;
    previousFilter.current = filter;
    scrollRef.current?.focus();
  }, [filter]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    setViewportHeight(element.clientHeight);
    const observer = new ResizeObserver(() => setViewportHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT);
  const firstRow = Math.max(0, firstVisible - OVERSCAN);
  const lastRow = Math.min(total, firstVisible + visibleCount + OVERSCAN);
  // Both are counted in pane rows; the layout's own indices start one lower with the node drawn.
  const windowRows = rows.slice(Math.max(0, firstRow - offset), Math.max(0, lastRow - offset));
  // A stash is a commit the graph reaches only because it was named, and its subject reads like
  // any other commit's. The selector, and the square the canvas draws it as, are what tell it.
  const stashOf = useMemo(
    () => new Map(graph.stashes.map((stash) => [stash.oid, stash.selector])),
    [graph.stashes],
  );
  const windowEdges = useMemo(
    () =>
      edges.filter(
        (edge) => edge.childRow + offset <= lastRow && edge.parentRow + offset >= firstRow,
      ),
    [edges, firstRow, lastRow, offset],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const width = laneCount * LANE_WIDTH + LANE_WIDTH;
    const height = Math.max(1, lastRow - firstRow) * ROW_HEIGHT;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext('2d');
    if (context === null) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.lineWidth = 2;
    context.lineCap = 'round';

    const x = (lane: number): number => LANE_WIDTH / 2 + lane * LANE_WIDTH;
    const y = (row: number): number => ROW_HEIGHT / 2 + (row - firstRow) * ROW_HEIGHT;

    for (const edge of windowEdges) {
      const x1 = x(edge.childLane);
      const y1 = y(edge.childRow + offset);
      const x2 = x(edge.parentLane);
      const y2 = y(edge.parentRow + offset);
      context.strokeStyle = laneColor(edge.childLane);
      context.beginPath();
      context.moveTo(x1, y1);
      if (x1 === x2) {
        context.lineTo(x2, y2);
      } else {
        context.bezierCurveTo(x1, y1 + (y2 - y1) * 0.55, x2, y1 + (y2 - y1) * 0.45, x2, y2);
      }
      context.stroke();
    }

    for (const row of windowRows) {
      const isSelected = row.commit.hash === selected;
      const radius = isSelected ? 6 : 4.5;
      context.beginPath();
      if (stashOf.has(row.commit.hash)) {
        // A square rather than a disc: a stash is not a commit of the history, and the shape says
        // so without colour, which is the same rule the badges follow.
        const side = radius * 1.6;
        context.rect(x(row.lane) - side, y(row.row + offset) - side, side * 2, side * 2);
      } else {
        context.arc(x(row.lane), y(row.row + offset), radius, 0, Math.PI * 2);
      }
      context.fillStyle = laneColor(row.lane);
      context.fill();
      context.lineWidth = isSelected ? 2 : 1;
      context.strokeStyle = isSelected ? '#f5f7fa' : '#0f1115';
      context.stroke();
      context.lineWidth = 2;
    }

    // The working tree sits above the first commit and is joined to the one HEAD is on. A ring
    // rather than a disc, because it is not a commit and must not read as one.
    if (wipShown) {
      context.strokeStyle = laneColor(headLane);
      context.beginPath();
      context.moveTo(x(headLane), y(0));
      context.lineTo(x(headLane), y(headRow + offset));
      context.stroke();
      context.beginPath();
      context.arc(x(headLane), y(0), 4.5, 0, Math.PI * 2);
      context.fillStyle = '#0f1115';
      context.fill();
      context.lineWidth = 2;
      context.stroke();
    }
  }, [
    windowRows,
    windowEdges,
    selected,
    firstRow,
    lastRow,
    laneCount,
    offset,
    headRow,
    headLane,
    wipShown,
    stashOf,
  ]);

  const keepInView = useCallback((index: number) => {
    const element = scrollRef.current;
    if (element === null) return;
    const top = index * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight) {
      element.scrollTop = bottom - element.clientHeight;
    }
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const current =
        selected === null ? -1 : rows.findIndex((row) => row.commit.hash === selected);
      let next: number | null = null;
      if (event.key === 'ArrowDown') next = current + 1;
      else if (event.key === 'ArrowUp') next = current - 1;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = commitCount - 1;
      if (next === null) return;
      event.preventDefault();
      const clamped = Math.max(0, Math.min(commitCount - 1, next));
      const row = rows[clamped];
      if (row === undefined) return;
      onSelect(row.commit.hash);
      // The pane's rows are shifted down by the node, and the scroll is in pane rows.
      keepInView(clamped + offset);
    },
    [commitCount, keepInView, offset, onSelect, rows, selected],
  );

  return (
    <div className="graph">
      <div className="graph-head">
        <span data-testid="graph-count">{describeWindow(graph, laneCount)}</span>
        {filter === '*' ? null : <span className="graph-history">on {filter}</span>}
        {graph.hidden.length === 0 ? null : (
          <span className="graph-history" data-testid="graph-hidden">
            hiding {graph.hidden.length}
          </span>
        )}
        {searching ? (
          <span className="graph-history" data-testid="graph-search">
            searching
          </span>
        ) : null}
        {graph.truncated && (
          <button type="button" data-testid="load-more" onClick={onLoadMore}>
            Load {pageSize} more
          </button>
        )}
      </div>
      <div
        className="graph-scroll"
        data-testid="graph-scroll"
        ref={scrollRef}
        role="listbox"
        aria-label="Commit graph"
        tabIndex={0}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onKeyDown={onKeyDown}
      >
        <div className="graph-inner" style={{ height: total * ROW_HEIGHT }}>
          <canvas
            ref={canvasRef}
            data-testid="graph-canvas"
            className="commit-graph"
            style={{ top: firstRow * ROW_HEIGHT }}
          />
          {wipShown && firstRow === 0 && (
            <button
              type="button"
              className="row wip"
              data-testid="wip-row"
              disabled={onWipClick === undefined}
              style={{
                top: 0,
                height: ROW_HEIGHT,
                paddingLeft: laneCount * LANE_WIDTH + LANE_WIDTH + TEXT_GUTTER,
              }}
              onClick={() => onWipClick?.()}
            >
              <span className="wip-name">WIP</span>
              <span className="subject">{describeNode(graph.wip)}</span>
              <span className="meta">
                {onWipClick === undefined ? 'not committed' : 'not committed — go to it'}
              </span>
            </button>
          )}
          {windowRows.map((row) => {
            const isSelected = row.commit.hash === selected;
            const stash = stashOf.get(row.commit.hash);
            const badges = [
              ...(stash === undefined
                ? []
                : [{ name: stash, shortName: stash, kind: 'stash', isHead: false }]),
              ...(graph.refsByOid.get(row.commit.hash) ?? []),
            ];
            return (
              <button
                key={row.commit.hash}
                type="button"
                data-testid="commit-row"
                data-hash={row.commit.hash}
                className={isSelected ? 'row selected' : 'row'}
                style={{
                  top: (row.row + offset) * ROW_HEIGHT,
                  height: ROW_HEIGHT,
                  paddingLeft: laneCount * LANE_WIDTH + LANE_WIDTH + TEXT_GUTTER,
                }}
                onClick={() => onSelect(row.commit.hash)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onSelect(row.commit.hash);
                  openMenu(
                    { hash: row.commit.hash, subject: row.commit.subject },
                    event.clientX,
                    event.clientY,
                    event.currentTarget,
                  );
                }}
                onKeyDown={(event) => {
                  // Shift+F10 and the ContextMenu key are the keyboard's right-click: this is
                  // the reason the menu is not a mouse-only feature.
                  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  onSelect(row.commit.hash);
                  const rect = event.currentTarget.getBoundingClientRect();
                  openMenu(
                    { hash: row.commit.hash, subject: row.commit.subject },
                    rect.left + 12,
                    rect.bottom,
                    event.currentTarget,
                  );
                }}
              >
                {isSelected && (
                  <span
                    className="row-marker"
                    data-testid="commit-row-selected"
                    data-hash={row.commit.hash}
                    aria-hidden="true"
                  />
                )}
                {badges.map((badge) => (
                  <span key={badge.name} className={`badge ${badge.kind}`}>
                    <RefIcon kind={badge.kind} isHead={badge.isHead} />
                    {badge.shortName}
                  </span>
                ))}
                <span className="subject">{row.commit.subject}</span>
                <span className="meta">
                  {row.commit.author.name} · {row.commit.hash.slice(0, 7)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {menu !== null && (
        <div
          className="commit-menu"
          data-testid="commit-menu"
          role="menu"
          aria-label="Commit actions"
          ref={menuRef}
          style={{ left: menuAt?.left ?? menu.x, top: menuAt?.top ?? menu.y }}
          onKeyDown={onMenuKeyDown}
        >
          {COMMIT_MENU_ITEMS.map((item, index) => (
            <button
              key={item.action}
              type="button"
              role="menuitem"
              data-testid="menu-item"
              data-action={item.action}
              className={[
                'commit-menu-item',
                index === focusedItem ? 'focused' : '',
                item.danger === true ? 'danger' : '',
              ]
                .filter((name) => name !== '')
                .join(' ')}
              ref={(element) => {
                menuItemsRef.current[index] = element;
              }}
              onClick={() => activateMenuItem(item.action)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
