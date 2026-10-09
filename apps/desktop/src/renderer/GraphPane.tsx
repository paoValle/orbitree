import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { GraphData } from '../shared/api.ts';

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

/** The header always says which window of the history is on screen: `300 of 2054 commits`. */
function describeWindow(graph: GraphData, laneCount: number): string {
  const commits = `${graph.commits.length} of ${graph.total} commits`;
  return `${commits} · ${laneCount} lane${laneCount === 1 ? '' : 's'}`;
}

export interface GraphPaneProps {
  readonly graph: GraphData;
  readonly selected: string | null;
  readonly onSelect: (hash: string) => void;
  /** `*` reads every ref; anything else is the revision to read instead. */
  readonly filter: string;
  readonly onFilterChange: (value: string) => void;
  /** One page of history; the load-more button asks for one more. */
  readonly pageSize: number;
  readonly onLoadMore: () => void;
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
  onFilterChange,
  pageSize,
  onLoadMore,
}: GraphPaneProps): React.ReactElement {
  const rows = graph.layout.rows;
  const edges = graph.layout.edges;
  const laneCount = graph.layout.laneCount;
  const total = rows.length;

  // Branches first, then remotes, then tags: the order a reader looks for a history in.
  const refOptions = useMemo(
    () => [
      ...graph.refs.filter((ref) => ref.kind === 'branch'),
      ...graph.refs.filter((ref) => ref.kind === 'remote'),
      ...graph.refs.filter((ref) => ref.kind === 'tag'),
    ],
    [graph.refs],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

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
  const windowRows = rows.slice(firstRow, lastRow);
  const windowEdges = useMemo(
    () => edges.filter((edge) => edge.childRow <= lastRow && edge.parentRow >= firstRow),
    [edges, firstRow, lastRow],
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
      const y1 = y(edge.childRow);
      const x2 = x(edge.parentLane);
      const y2 = y(edge.parentRow);
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
      context.beginPath();
      context.arc(x(row.lane), y(row.row), isSelected ? 6 : 4.5, 0, Math.PI * 2);
      context.fillStyle = laneColor(row.lane);
      context.fill();
      context.lineWidth = isSelected ? 2 : 1;
      context.strokeStyle = isSelected ? '#f5f7fa' : '#0f1115';
      context.stroke();
      context.lineWidth = 2;
    }
  }, [windowRows, windowEdges, selected, firstRow, lastRow, laneCount]);

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
      else if (event.key === 'End') next = total - 1;
      if (next === null) return;
      event.preventDefault();
      const clamped = Math.max(0, Math.min(total - 1, next));
      const row = rows[clamped];
      if (row === undefined) return;
      onSelect(row.commit.hash);
      keepInView(clamped);
    },
    [keepInView, onSelect, rows, selected, total],
  );

  return (
    <div className="graph">
      <div className="graph-head">
        <span data-testid="graph-count">{describeWindow(graph, laneCount)}</span>
        <select
          data-testid="ref-filter"
          aria-label="History"
          value={filter}
          onChange={(event) => {
            onFilterChange(event.target.value);
            // Release the select so the arrow keys stay on the graph rows, which is where
            // the reader is looking after asking for a different history.
            scrollRef.current?.focus();
          }}
        >
          <option value="*">All branches</option>
          {refOptions.map((ref) => (
            <option key={ref.name} value={ref.shortName}>
              {ref.shortName}
            </option>
          ))}
        </select>
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
          {windowRows.map((row) => {
            const isSelected = row.commit.hash === selected;
            const badges = graph.refsByOid.get(row.commit.hash) ?? [];
            return (
              <button
                key={row.commit.hash}
                type="button"
                data-testid="commit-row"
                data-hash={row.commit.hash}
                className={isSelected ? 'row selected' : 'row'}
                style={{
                  top: row.row * ROW_HEIGHT,
                  height: ROW_HEIGHT,
                  paddingLeft: laneCount * LANE_WIDTH + LANE_WIDTH + TEXT_GUTTER,
                }}
                onClick={() => onSelect(row.commit.hash)}
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
    </div>
  );
}
