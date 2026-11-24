#!/usr/bin/env node
// Builds tokens.css from tokens.json (W3C DTCG). Zero dependencies.
// Usage: node design-system/tokens/build.mjs [--check]
//   --check  exit 1 if tokens.css is out of date (use in CI / pre-commit).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = JSON.parse(readFileSync(join(here, 'tokens.json'), 'utf8'));
const out = join(here, 'tokens.css');

const get = (path) => path.split('.').reduce((o, k) => {
  if (o == null || !(k in o)) throw new Error(`Unknown token reference {${path}}`);
  return o[k];
}, src);

function resolve(v) {
  if (typeof v === 'string') {
    const m = v.match(/^\{(.+)\}$/);
    if (m) { const t = get(m[1]); return resolve(t.$value); }
    return v;
  }
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
  return v;
}

function format(value, type) {
  if (type === 'fontFamily') return value.map((f) => (/\s/.test(f) ? `'${f}'` : f)).join(', ');
  if (type === 'cubicBezier') return `cubic-bezier(${value.join(', ')})`;
  if (type === 'shadow') return `${value.offsetX} ${value.offsetY} ${value.blur} ${value.spread} ${value.color}`;
  return String(value);
}

// walk a group, yielding [name-parts, value, type]
function* walk(node, path = [], type) {
  const t = node.$type || type;
  if ('$value' in node) { yield [path, resolve(node.$value), t]; return; }
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('$')) continue;
    yield* walk(v, [...path, k], t);
  }
}

const decl = (prefix, node) => [...walk(node)].map(([p, v, t]) => `  --${[prefix, ...p].filter(Boolean).join('-')}: ${format(v, t)};`).join('\n');

const themeBlock = (name) => {
  const th = src.theme[name];
  return [decl('color', th.color), decl('shadow', th.shadow)].join('\n');
};

const css = `/* GENERATED FILE — do not edit. Source: design-system/tokens/tokens.json
   Rebuild: node design-system/tokens/build.mjs
   Only semantic tokens are exposed. Primitives stay in tokens.json on purpose. */

:root {
${decl('space', src.space)}
${decl('radius', src.radius)}
${decl('font-family', src.font.family)}
${decl('font-weight', src.font.weight)}
${decl('font-size', src.font.size)}
${decl('line-height', src.font['line-height'])}
${decl('tracking', src.font.tracking)}
${decl('motion-duration', src.motion.duration)}
${decl('motion-easing', src.motion.easing)}
${decl('layout', src.layout)}
${decl('z', src.z)}
}

:root {
  color-scheme: dark;
${themeBlock('dark')}
}

@media (prefers-reduced-motion: reduce) {
  :root { --motion-duration-fast: 0ms; --motion-duration-base: 0ms; --motion-duration-slow: 0ms; }
}
`;

if (process.argv.includes('--check')) {
  const cur = existsSync(out) ? readFileSync(out, 'utf8') : '';
  if (cur !== css) { console.error('tokens.css is out of date. Run: node design-system/tokens/build.mjs'); process.exit(1); }
  console.log('tokens.css is up to date.');
} else {
  writeFileSync(out, css);
  console.log(`Wrote ${out}`);
}
