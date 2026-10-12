/**
 * The icon set: one geometric glyph per thing the product names, drawn inline on the 24px
 * grid `docs/DESIGN.md` specifies.
 *
 * These are not an illustration set and not a dependency. Each glyph is a single-colour
 * line drawing on whole or half pixels with a 1.5px stroke, so it reads at 14px, survives
 * being printed in one colour, and renders the same on every platform. `data-icon` carries
 * the name, so a test asserts a name instead of a drawing.
 */
export interface IconProps {
  readonly size?: number;
}

interface GlyphProps {
  readonly name: string;
  readonly size: number | undefined;
  readonly children: React.ReactNode;
}

function Glyph({ name, size, children }: GlyphProps): React.ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size ?? 14}
      height={size ?? 14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon={name}
    >
      {children}
    </svg>
  );
}

/** The file silhouette every `file-*` glyph is built on, so the family reads as one. */
function Page({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  return (
    <>
      <path d="M13.5 3H7.5A2 2 0 0 0 5.5 5v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8.5z" />
      <path d="M13.5 3v5.5h5" />
      {children}
    </>
  );
}

/** Put the working tree aside: fetch, then stash. */
export function FetchIcon({ size }: IconProps): React.ReactElement {
  return (
    <Glyph name="fetch" size={size}>
      <path d="M12 4v11" />
      <path d="m8 11 4 4 4-4" />
      <path d="M4 19h16" />
    </Glyph>
  );
}

export function PullIcon({ size }: IconProps): React.ReactElement {
  return (
    <Glyph name="pull" size={size}>
      <path d="M12 3v9" />
      <path d="m8 8 4 4 4-4" />
      <path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
    </Glyph>
  );
}

export function PushIcon({ size }: IconProps): React.ReactElement {
  return (
    <Glyph name="push" size={size}>
      <path d="M12 20v-9" />
      <path d="m8 15 4-4 4 4" />
      <path d="M4 4h16" />
    </Glyph>
  );
}

export function StashIcon({ size }: IconProps): React.ReactElement {
  return (
    <Glyph name="stash" size={size}>
      <rect x="4" y="5" width="16" height="4" rx="1" />
      <path d="M5.5 9v9a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5V9" />
      <path d="M12 12v4.5" />
      <path d="m9.5 14 2.5 2.5 2.5-2.5" />
    </Glyph>
  );
}

export function UnstashIcon({ size }: IconProps): React.ReactElement {
  return (
    <Glyph name="unstash" size={size}>
      <rect x="4" y="5" width="16" height="4" rx="1" />
      <path d="M5.5 9v9a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5V9" />
      <path d="M12 16.5V12" />
      <path d="m9.5 14.5 2.5-2.5 2.5 2.5" />
    </Glyph>
  );
}

export function CleanIcon({ size }: IconProps): React.ReactElement {
  return (
    <Glyph name="clean" size={size}>
      <path d="M4 7h16" />
      <path d="M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7" />
      <path d="m6.5 7 .8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
      <path d="M10.5 11v6" />
      <path d="M13.5 11v6" />
    </Glyph>
  );
}

export function ResetIcon({ size }: IconProps): React.ReactElement {
  return (
    <Glyph name="reset" size={size}>
      <path d="M4 12a8 8 0 1 0 2.34-5.66L4 8" />
      <path d="M4 4v4h4" />
    </Glyph>
  );
}

export function FileTextIcon({ size }: IconProps): React.ReactElement {
  return (
    <Glyph name="file-text" size={size}>
      <Page>
        <path d="M9 12.5h6" />
        <path d="M9 15.5h6" />
        <path d="M9 18h3.5" />
      </Page>
    </Glyph>
  );
}

export function FileCodeIcon({ size }: IconProps): React.ReactElement {
  return (
    <Glyph name="file-code" size={size}>
      <Page>
        <path d="m10.5 12.5-2 2.5 2 2.5" />
        <path d="m13.5 12.5 2 2.5-2 2.5" />
      </Page>
    </Glyph>
  );
}

export function FileJsonIcon({ size }: IconProps): React.ReactElement {
  return (
    <Glyph name="file-json" size={size}>
      <Page>
        <path d="M11 11c-.9 0-1.2.5-1.2 1.2v1c0 .8-.4 1.3-1.3 1.3.9 0 1.3.5 1.3 1.3v1c0 .7.3 1.2 1.2 1.2" />
        <path d="M13 11c.9 0 1.2.5 1.2 1.2v1c0 .8.4 1.3 1.3 1.3-.9 0-1.3.5-1.3 1.3v1c0 .7-.3 1.2-1.2 1.2" />
      </Page>
    </Glyph>
  );
}

export function FileImageIcon({ size }: IconProps): React.ReactElement {
  return (
    <Glyph name="file-image" size={size}>
      <Page>
        <circle cx="10.5" cy="12.5" r="1" />
        <path d="m8.5 18 3-3 1.5 1.5 2-2 2.5 2.5" />
      </Page>
    </Glyph>
  );
}

export function FileBinaryIcon({ size }: IconProps): React.ReactElement {
  return (
    <Glyph name="file-binary" size={size}>
      <Page>
        <path d="m10 11.5 1.5-1v7" />
        <circle cx="14.8" cy="14.3" r="3.2" />
      </Page>
    </Glyph>
  );
}

export function FileConfigIcon({ size }: IconProps): React.ReactElement {
  return (
    <Glyph name="file-config" size={size}>
      <Page>
        <path d="M9 12.5h7" />
        <circle cx="11.5" cy="12.5" r="1.4" />
        <path d="M9 16.5h7" />
        <circle cx="14.5" cy="16.5" r="1.4" />
      </Page>
    </Glyph>
  );
}

export function FileShellIcon({ size }: IconProps): React.ReactElement {
  return (
    <Glyph name="file-shell" size={size}>
      <Page>
        <path d="m9.5 12 2.5 2.5-2.5 2.5" />
        <path d="M14 17h3" />
      </Page>
    </Glyph>
  );
}

export function FileMarkdownIcon({ size }: IconProps): React.ReactElement {
  return (
    <Glyph name="file-markdown" size={size}>
      <Page>
        <path d="M9 17v-5l3 3 3-3v5" />
      </Page>
    </Glyph>
  );
}

export function BranchIcon({ size }: IconProps): React.ReactElement {
  return (
    <Glyph name="branch" size={size}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <path d="M6 8v8" />
      <circle cx="18" cy="12" r="2" />
      <path d="M18 10V9a3 3 0 0 0-3-3H6" />
    </Glyph>
  );
}

export function RemoteIcon({ size }: IconProps): React.ReactElement {
  return (
    <Glyph name="remote" size={size}>
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16" />
      <path d="M12 4a11 11 0 0 1 0 16" />
      <path d="M12 4a11 11 0 0 0 0 16" />
    </Glyph>
  );
}

export function TagIcon({ size }: IconProps): React.ReactElement {
  return (
    <Glyph name="tag" size={size}>
      <path d="M11.5 3H5a2 2 0 0 0-2 2v6.5a2 2 0 0 0 .6 1.4l7.5 7.5a2 2 0 0 0 2.8 0l6.6-6.6a2 2 0 0 0 0-2.8l-7.5-7.5A2 2 0 0 0 11.5 3z" />
      <circle cx="8" cy="8" r="1.4" />
    </Glyph>
  );
}

export function HeadIcon({ size }: IconProps): React.ReactElement {
  return (
    <Glyph name="head" size={size}>
      <path d="M12 21s6.5-5.3 6.5-10.5a6.5 6.5 0 1 0-13 0C5.5 15.7 12 21 12 21z" />
      <circle cx="12" cy="10.5" r="2.3" />
    </Glyph>
  );
}

export function CommitIcon({ size }: IconProps): React.ReactElement {
  return (
    <Glyph name="commit" size={size}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M3.5 12h5.3" />
      <path d="M15.2 12h5.3" />
    </Glyph>
  );
}

export function TreeIcon({ size }: IconProps): React.ReactElement {
  return (
    <Glyph name="tree" size={size}>
      <path d="M6 4v16" />
      <path d="M6 8.5h5" />
      <path d="M6 15.5h5" />
      <rect x="11" y="6" width="8" height="5" rx="1.2" />
      <rect x="11" y="13" width="8" height="5" rx="1.2" />
    </Glyph>
  );
}

export function StashBoxIcon({ size }: IconProps): React.ReactElement {
  return (
    <Glyph name="stash-box" size={size}>
      <rect x="4" y="7" width="16" height="13" rx="1.5" />
      <path d="m4 7 1.6-3h12.8L20 7" />
      <path d="M10 12h4" />
    </Glyph>
  );
}

export function ActivityIcon({ size }: IconProps): React.ReactElement {
  return (
    <Glyph name="activity" size={size}>
      <path d="M3.5 12h4l2.5-6 4 12 2.5-6h4" />
    </Glyph>
  );
}

export function CloseIcon({ size }: IconProps): React.ReactElement {
  return (
    <Glyph name="close" size={size}>
      <path d="m6 6 12 12" />
      <path d="M18 6 6 18" />
    </Glyph>
  );
}

export function ChevronDownIcon({ size }: IconProps): React.ReactElement {
  return (
    <Glyph name="chevron-down" size={size}>
      <path d="m6 9.5 6 6 6-6" />
    </Glyph>
  );
}

export function FolderIcon({ size }: IconProps): React.ReactElement {
  return (
    <Glyph name="folder" size={size}>
      <path d="M3.5 7A2 2 0 0 1 5.5 5h3.1a2 2 0 0 1 1.6.8l1 1.2h7.3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </Glyph>
  );
}

export function SearchIcon({ size }: IconProps): React.ReactElement {
  return (
    <Glyph name="search" size={size}>
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-4.5-4.5" />
    </Glyph>
  );
}

/** The glyph per quick-command id: the toolbar and the quick window must agree. */
const QUICK_ICONS: Readonly<Record<string, (props: IconProps) => React.ReactElement>> = {
  fetch: FetchIcon,
  pull: PullIcon,
  push: PushIcon,
  stash: StashIcon,
  pop: UnstashIcon,
  clean: CleanIcon,
  'reset-hard': ResetIcon,
};

export function quickIcon(id: string): ((props: IconProps) => React.ReactElement) | null {
  return QUICK_ICONS[id] ?? null;
}
