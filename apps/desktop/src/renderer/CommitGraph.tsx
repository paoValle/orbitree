import type { GraphEdge, GraphRow } from '@keplerk/core';
import { useEffect, useMemo, useRef } from 'react';

export const ROW_HEIGHT = 26;
export const LANE_WIDTH = 16;
export const TEXT_GUTTER = 12;

export const LANE_COLORS = [
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

export interface CommitGraphProps {
  readonly rows: readonly GraphRow[];
  readonly edges: readonly GraphEdge[];
  readonly selected: string | null;
  readonly onSelect: (hash: string) => void;
}

/**
 * The picture the product exists for.
 *
 * A canvas rather than an SVG tree: one node and a handful of curves per commit is fine in
 * the DOM for a hundred commits and painful at ten thousand. The canvas is one element, so
 * the cost of a large history is drawing, not reconciling. The text beside it stays in the
 * DOM, which keeps commit subjects selectable and screen-reader friendly.
 *
 * ponytail: the whole history is drawn, not the visible window. Virtualise when a
 * 100k-commit repository is measured, not before.
 */
export function CommitGraph({
  rows,
  edges,
  selected,
  onSelect,
}: CommitGraphProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const laneCount = useMemo(
    () => rows.reduce((count, row) => Math.max(count, row.lane, ...row.through) + 1, 1),
    [rows],
  );
  const width = laneCount * LANE_WIDTH + LANE_WIDTH;
  const height = rows.length * ROW_HEIGHT;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
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
    const y = (row: number): number => ROW_HEIGHT / 2 + row * ROW_HEIGHT;

    for (const edge of edges) {
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
        // A smooth S: vertical out of the child, vertical into the parent.
        context.bezierCurveTo(x1, y1 + (y2 - y1) * 0.55, x2, y1 + (y2 - y1) * 0.45, x2, y2);
      }
      context.stroke();
    }

    for (const row of rows) {
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
  }, [rows, edges, selected, width, height]);

  return (
    <canvas
      ref={canvasRef}
      className="commit-graph"
      onClick={(event) => {
        const canvas = canvasRef.current;
        if (canvas === null) return;
        const offset = event.clientY - canvas.getBoundingClientRect().top;
        const row = rows[Math.floor(offset / ROW_HEIGHT)];
        if (row !== undefined) onSelect(row.commit.hash);
      }}
    />
  );
}
