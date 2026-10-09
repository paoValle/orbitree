import type { DiffFile, DiffLine } from '../shared/api.ts';

/** The test-id per line kind; a `note` (git's "no newline" marker) is neither add nor del. */
function lineTestId(kind: DiffLine['kind']): string | undefined {
  if (kind === 'add') return 'diff-line-add';
  if (kind === 'del') return 'diff-line-del';
  if (kind === 'context') return 'diff-line-context';
  return undefined;
}

function gutter(kind: DiffLine['kind']): string {
  if (kind === 'add') return '+';
  if (kind === 'del') return '-';
  if (kind === 'note') return '\\';
  return ' ';
}

/**
 * One file's unified diff, as the parser returned it. The hunk header is printed verbatim
 * because it is git's own line and re-formatting it would lose the section title git puts
 * after the second `@@`.
 */
export function DiffView({ file }: { readonly file: DiffFile }): React.ReactElement {
  if (file.binary) return <p className="empty">binary file</p>;
  if (file.hunks.length === 0) return <p className="empty">no textual changes</p>;

  return (
    <div className="diff">
      {file.hunks.map((hunk) => (
        <div className="hunk" data-testid="diff-hunk" key={hunk.header}>
          <div className="hunk-header">{hunk.header}</div>
          {hunk.lines.map((line, lineIndex) => (
            <div
              className={`diff-line ${line.kind}`}
              data-testid={lineTestId(line.kind)}
              // biome-ignore lint/suspicious/noArrayIndexKey: a diff line has no identity but its position
              key={lineIndex}
            >
              <span className="gutter">{gutter(line.kind)}</span>
              <span className="dtext">{line.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
