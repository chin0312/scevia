#!/usr/bin/env node
// Scevia design lint — enforces the design system mechanically, so DESIGN.md is not "just a suggestion".
// Zero dependencies. Usage:
//   node design-system/lint/design-lint.mjs [paths...]      (default: web/src + concept folders)
//   node design-system/lint/design-lint.mjs --contrast      (checks WCAG contrast of semantic text pairs in both themes)
// Exit code 1 on any error. Warnings never fail the build.
// Escape hatch: a line containing `design-lint-allow: <rule> <reason>` skips that rule on that line.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const tokensCss = readFileSync(join(root, 'design-system/tokens/tokens.css'), 'utf8');

if (args.includes('--contrast')) process.exit(contrast());

const targets = (args.length ? args : ['web/src', 'design-concepts/v2']).map((p) => join(root, p)).filter(existsSync);
const EXT = new Set(['.css', '.html', '.js', '.mjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte']);
const SKIP = /(node_modules|\/v1\/|tokens\.css$|\.min\.)/;

const files = [];
const collect = (p) => { if (SKIP.test(p)) return; const s = statSync(p); if (s.isDirectory()) readdirSync(p).forEach((f) => collect(join(p, f))); else if (EXT.has(extname(p))) files.push(p); };
targets.forEach(collect);

// every custom property declared anywhere (tokens + component-local) is a known token
const declared = new Set([...tokensCss.matchAll(/--([\w-]+)\s*:/g)].map((m) => m[1]));
for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/--([\w-]+)\s*:/g)) declared.add(m[1]);

const RULES = [
  { id: 'raw-color', level: 'error', re: /(?:[:\s(,]|(?:fill|stroke|color|stop-color)=["'])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g,
    msg: 'Raw hex color. Use a semantic token, e.g. var(--color-text-secondary).' },
  { id: 'raw-color-fn', level: 'error', re: /\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/g, msg: 'Raw color function. Use a semantic token (add one to tokens.json if truly missing).' },
  { id: 'named-color', level: 'error', re: /(?:color|background(?:-color)?|fill|stroke|border(?:-[a-z]+)?)\s*:\s*[^;"']*\b(?:white|black|red|green|blue|gray|grey|orange|purple)\b/g, msg: 'Named CSS color. Use a semantic token.' },
  { id: 'raw-font-family', level: 'error', re: /font-family\s*:(?!\s*(?:var\(|inherit))/g, msg: 'Font family must be var(--font-family-sans|mono).' },
  { id: 'raw-font-size', level: 'error', re: /font-size\s*:\s*\d|font-size=["']\d/g, msg: 'Font size must use var(--font-size-*).' },
  { id: 'unknown-token', level: 'error', re: /var\(--([\w-]+)/g, test: (m) => !declared.has(m[1]), msg: (m) => `Unknown token --${m[1]}. Check tokens.css for the right name.` },
  { id: 'off-scale-spacing', level: 'warn', re: /(?:^|[\s;{])(?:padding|margin|gap|row-gap|column-gap)(?:-[a-z]+)?\s*:\s*([^;}"]+)/g,
    test: (m) => m[1].split(/\s+/).some((v) => /^\d+(?:\.\d+)?px$/.test(v) && !['0px', '1px', '2px'].includes(v)), msg: 'Spacing outside the scale. Prefer var(--space-*).' },
  { id: 'important', level: 'warn', re: /!important/g, msg: 'Avoid !important; fix specificity instead.' },
];

let errors = 0, warns = 0;
for (const f of files) {
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const r of RULES) {
      if (line.includes(`design-lint-allow: ${r.id}`)) continue;
      for (const m of line.matchAll(r.re)) {
        if (r.test && !r.test(m)) continue;
        if (r.id === 'raw-color' && /href=["']#/.test(line.slice(Math.max(0, m.index - 6), m.index + 2))) continue;
        const msg = typeof r.msg === 'function' ? r.msg(m) : r.msg;
        console.log(`${r.level === 'error' ? 'ERROR' : 'warn '} ${relative(root, f)}:${i + 1}  [${r.id}] ${msg}`);
        r.level === 'error' ? errors++ : warns++;
      }
    }
  });
}
console.log(`\ndesign-lint: ${files.length} files, ${errors} error(s), ${warns} warning(s).`);
process.exit(errors ? 1 : 0);

// ── WCAG contrast check on semantic pairs ─────────────────────────────
function contrast() {
  const tok = JSON.parse(readFileSync(join(root, 'design-system/tokens/tokens.json'), 'utf8'));
  const get = (p) => p.split('.').reduce((o, k) => o[k], tok);
  const res = (v) => { const m = typeof v === 'string' && v.match(/^\{(.+)\}$/); return m ? res(get(m[1]).$value) : v; };
  const lum = (hex) => { const c = hex.slice(1, 7).match(/../g).map((x) => parseInt(x, 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  // [foreground, background, minimum] — 4.5 for body text, 3 for large figures/UI glyphs
  const PAIRS = [
    ['text.primary', 'bg.surface', 4.5], ['text.secondary', 'bg.surface', 4.5], ['text.tertiary', 'bg.surface', 4.5],
    ['text.secondary', 'bg.canvas', 4.5], ['text.tertiary', 'bg.raised', 4.5],
    ['gain.fg', 'bg.surface', 4.5], ['loss.fg', 'bg.surface', 4.5], ['warn.fg', 'bg.surface', 4.5], ['info.fg', 'bg.surface', 4.5],
    ['gain.fg', 'gain.bg', 4.5], ['loss.fg', 'loss.bg', 4.5], ['warn.fg', 'warn.bg', 4.5], ['accent.fg', 'accent.bg', 4.5],
    ['action.primary-fg', 'action.primary-bg', 4.5], ['accent.on-solid', 'accent.solid', 4.5],
    ['data.1', 'bg.surface', 3], ['data.2', 'bg.surface', 3], ['data.3', 'bg.surface', 3], ['data.4', 'bg.surface', 3], ['data.5', 'bg.surface', 3], ['data.6', 'bg.surface', 3],
    ['focus.ring', 'bg.surface', 3],
  ];
  let fails = 0;
  for (const theme of Object.keys(tok.theme)) {
    const c = (p) => res(get(`theme.${theme}.color.${p}`).$value);
    console.log(`\n${theme}`);
    for (const [fg, bg, min] of PAIRS) {
      const r = ratio(c(fg), c(bg)); const ok = r >= min; if (!ok) fails++;
      console.log(`  ${ok ? 'pass' : 'FAIL'}  ${r.toFixed(2).padStart(5)} ≥ ${min}  ${fg} on ${bg}`);
    }
  }
  console.log(`\ncontrast: ${fails} failure(s)`);
  return fails ? 1 : 0;
}
