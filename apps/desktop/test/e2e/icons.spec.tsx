import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { renderToStaticMarkup } from 'react-dom/server';
import * as iconSet from '../../src/renderer/icons.tsx';
import { closeApp, launchApp, mainWindow } from './support.ts';

/**
 * The icon set, judged as a set.
 *
 * `docs/DESIGN.md` says the test of an icon set is a screenshot a person can read, at the sizes the
 * glyphs are used at, in one colour. That is a judgement no assertion can make, so this spec's job
 * is to produce the picture — rendered from the components themselves, so the gallery cannot go
 * stale behind the set — and to fail on the two mistakes a picture cannot show: a glyph that draws
 * nothing, and two glyphs claiming the same name.
 *
 * It runs in the suite because the exit criterion of P1.5 asks for it in the same run that draws
 * everything else, and because a window is what `setContent` needs to draw into.
 */

type GlyphProps = { readonly size?: number };
type Glyph = (props: GlyphProps) => React.ReactElement;

/**
 * Every glyph, discovered rather than listed: an enumeration would go stale the first time somebody
 * adds an icon, and a gallery missing the new glyph is a gallery that lies about its own coverage.
 * `quickIcon` is a lookup rather than a glyph, so it is the one export excluded by name.
 */
function everyGlyph(): readonly (readonly [string, Glyph])[] {
  return Object.entries(iconSet)
    .filter(
      (entry): entry is [string, Glyph] =>
        typeof entry[1] === 'function' && entry[0].endsWith('Icon') && entry[0] !== 'quickIcon',
    )
    .sort(([a], [b]) => a.localeCompare(b));
}

/** The sizes the product actually draws: 16 where a kind must be told apart, 14 everywhere else. */
const SIZES = [16, 14] as const;

const STYLE = `
  :root { color-scheme: dark; }
  body {
    margin: 0;
    padding: 16px 20px;
    /* The window's own palette, so a glyph is judged on the surface it is used on. */
    background: #0f1115;
    color: #e6e9ef;
    font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .title { margin: 0 0 12px; color: #9aa4b2; font-weight: 400; }
  .gallery { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px 20px; }
  .cell { display: flex; align-items: center; gap: 10px; }
  .pair { display: flex; align-items: center; gap: 8px; }
  .name { color: #9aa4b2; }
`;

function Gallery({ glyphs }: { readonly glyphs: readonly (readonly [string, Glyph])[] }) {
  return (
    <div className="gallery">
      {glyphs.map(([name, Icon]) => (
        <div className="cell" key={name}>
          <span className="pair">
            {SIZES.map((size) => (
              <Icon key={size} size={size} />
            ))}
          </span>
          {/* The label is here so a reader can tell whether the drawing alone would have said it. */}
          <span className="name">{name.replace(/Icon$/, '')}</span>
        </div>
      ))}
    </div>
  );
}

test('every glyph, at the sizes it is drawn, in one colour', async () => {
  const glyphs = everyGlyph();
  const gallery = renderToStaticMarkup(<Gallery glyphs={glyphs} />);

  // One `<svg>` per glyph per size, each naming itself, and no two names alike: a copy-pasted
  // glyph keeps its name and would otherwise be two drawings the product cannot tell apart.
  const names = [...gallery.matchAll(/data-icon="([^"]+)"/g)].map((match) => match[1]);
  expect(names).toHaveLength(glyphs.length * SIZES.length);
  expect(new Set(names).size).toBe(glyphs.length);

  // And no two glyphs draw the same shape under different names, which is the other half of the
  // same mistake and the one a name alone does not catch. Each glyph is drawn once per size, in
  // order, so every `SIZES.length`-th drawing is a distinct glyph.
  const drawings = [...gallery.matchAll(/<svg[^>]*>(.*?)<\/svg>/g)].map((match) => match[1]);
  const perGlyph = drawings.filter((_, index) => index % SIZES.length === 0);
  expect(perGlyph).toHaveLength(glyphs.length);
  expect(new Set(perGlyph).size).toBe(glyphs.length);

  // Nothing draws nothing. An empty `<svg>` is a cell that says the icon has no shape, which is
  // the one thing the screenshot is there to notice and the one thing it cannot assert.
  for (const drawing of gallery.split('<svg').slice(1)) {
    expect(/<(path|circle|rect|line|polyline|polygon|ellipse)/.test(drawing)).toBe(true);
  }

  const handle = await launchApp();
  try {
    const page = await mainWindow(handle.app);
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>
        <p class="title">every glyph, 16px then 14px, one colour</p>
        ${gallery}
      </body></html>`,
    );

    const screenshot = resolve(import.meta.dirname, '..', '..', 'reports', 'icons.png');
    await mkdir(dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot });
    console.log(`screenshot: ${screenshot} — ${glyphs.length} glyphs`);
  } finally {
    await closeApp(handle);
  }
});
