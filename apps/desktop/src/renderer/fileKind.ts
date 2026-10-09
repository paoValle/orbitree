/**
 * What kind of file a path is.
 *
 * A table, not a chain of conditions: a new extension is a row, an unknown one falls through
 * to `other`, and no reader has to follow an `if` ladder to find out that `.md` is a document.
 * The kind is drawn as a one or two character glyph (text, not an icon font and not an image),
 * so the pane stays one font and one DOM node per entry.
 */
export type FileKind =
  | 'code'
  | 'doc'
  | 'markup'
  | 'style'
  | 'image'
  | 'binary'
  | 'config'
  | 'other';

export const KIND_GLYPH: Readonly<Record<FileKind, string>> = {
  code: '{}',
  doc: '#',
  markup: '<>',
  style: '~',
  image: '▣',
  binary: '01',
  config: '=',
  other: '·',
};

const KIND_BY_EXTENSION: Readonly<Record<string, FileKind>> = {
  ts: 'code',
  tsx: 'code',
  js: 'code',
  jsx: 'code',
  mjs: 'code',
  cjs: 'code',
  py: 'code',
  rb: 'code',
  go: 'code',
  rs: 'code',
  java: 'code',
  kt: 'code',
  kts: 'code',
  c: 'code',
  h: 'code',
  cc: 'code',
  cpp: 'code',
  hpp: 'code',
  cs: 'code',
  swift: 'code',
  php: 'code',
  sh: 'code',
  bash: 'code',
  zsh: 'code',
  fish: 'code',
  lua: 'code',
  ex: 'code',
  exs: 'code',
  erl: 'code',
  hs: 'code',
  ml: 'code',
  clj: 'code',
  scala: 'code',
  sql: 'code',
  r: 'code',
  dart: 'code',
  vue: 'code',
  svelte: 'code',
  astro: 'code',

  md: 'doc',
  markdown: 'doc',
  txt: 'doc',
  rst: 'doc',
  adoc: 'doc',
  org: 'doc',
  tex: 'doc',

  html: 'markup',
  htm: 'markup',
  xhtml: 'markup',
  xml: 'markup',

  css: 'style',
  scss: 'style',
  sass: 'style',
  less: 'style',
  styl: 'style',

  svg: 'image',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  ico: 'image',
  tif: 'image',
  tiff: 'image',
  avif: 'image',
  heic: 'image',

  exe: 'binary',
  dll: 'binary',
  so: 'binary',
  dylib: 'binary',
  bin: 'binary',
  o: 'binary',
  a: 'binary',
  class: 'binary',
  jar: 'binary',
  wasm: 'binary',
  zip: 'binary',
  gz: 'binary',
  tar: 'binary',
  bz2: 'binary',
  xz: 'binary',
  pdf: 'binary',
  woff: 'binary',
  woff2: 'binary',
  ttf: 'binary',
  otf: 'binary',
  eot: 'binary',
  mp3: 'binary',
  mp4: 'binary',
  mov: 'binary',

  json: 'config',
  jsonc: 'config',
  yaml: 'config',
  yml: 'config',
  toml: 'config',
  ini: 'config',
  cfg: 'config',
  conf: 'config',
  properties: 'config',
  env: 'config',
  lock: 'config',
  plist: 'config',
};

/** Files with no extension, matched on the whole lowercased basename. */
const KIND_BY_NAME: Readonly<Record<string, FileKind>> = {
  dockerfile: 'config',
  makefile: 'config',
  cmakelists: 'config',
  procfile: 'config',
  license: 'doc',
  readme: 'doc',
  '.gitignore': 'config',
  '.gitattributes': 'config',
  '.editorconfig': 'config',
  '.env': 'config',
  '.npmrc': 'config',
  '.nvmrc': 'config',
  '.babelrc': 'config',
  '.prettierrc': 'config',
  '.eslintrc': 'config',
};

export function fileKind(path: string): FileKind {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = base.lastIndexOf('.');
  if (dot > 0) {
    const byExtension = KIND_BY_EXTENSION[base.slice(dot + 1)];
    if (byExtension !== undefined) return byExtension;
  }
  return KIND_BY_NAME[base] ?? 'other';
}

export function kindGlyph(kind: FileKind): string {
  return KIND_GLYPH[kind];
}
