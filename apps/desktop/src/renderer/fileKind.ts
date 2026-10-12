/**
 * What kind of file a path is.
 *
 * A table, not a chain of conditions: a new extension is a row, an unknown one falls through
 * to `other`, and no reader has to follow an `if` ladder to find out that `.md` is markdown.
 * The kind names the glyph family the working tree draws (see `icons.tsx`), so a reader of
 * this file and a reader of the pane see the same vocabulary.
 */
export type FileKind =
  | 'code'
  | 'shell'
  | 'markdown'
  | 'text'
  | 'json'
  | 'config'
  | 'image'
  | 'binary'
  | 'other';

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
  css: 'code',
  scss: 'code',
  sass: 'code',
  less: 'code',
  styl: 'code',
  html: 'code',
  htm: 'code',
  xhtml: 'code',
  xml: 'code',
  graphql: 'code',
  proto: 'code',

  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  ps1: 'shell',
  bat: 'shell',
  cmd: 'shell',

  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',

  txt: 'text',
  rst: 'text',
  adoc: 'text',
  org: 'text',
  tex: 'text',

  json: 'json',
  jsonc: 'json',
  json5: 'json',
  geojson: 'json',

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
  psd: 'image',

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
  wav: 'binary',
  flac: 'binary',
  mp4: 'binary',
  mov: 'binary',
  avi: 'binary',
  mkv: 'binary',
  db: 'binary',
  sqlite: 'binary',
};

/** Files with no extension, matched on the whole lowercased basename. */
const KIND_BY_NAME: Readonly<Record<string, FileKind>> = {
  dockerfile: 'config',
  makefile: 'config',
  cmakelists: 'config',
  procfile: 'config',
  readme: 'markdown',
  license: 'text',
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
