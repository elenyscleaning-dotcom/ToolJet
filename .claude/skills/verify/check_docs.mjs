#!/usr/bin/env node
/**
 * Mechanical documentation checks for the ToolJet Docusaurus site.
 * No dependencies — run with `node .claude/skills/verify/check_docs.mjs`.
 *
 * Link resolution follows the real routing declared in docs/docusaurus.config.js:
 * every version is served under its own prefix, `lastVersion` is served
 * unprefixed, and the current docs/docs tree sits behind the `current` path.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname, basename, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SITE = join(REPO, 'docs');
const CURRENT = join(SITE, 'docs');
const STATIC = join(SITE, 'static');
const VERSIONED = join(SITE, 'versioned_docs');

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const flag = (name) => (args.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=');
const checkAll = has('all');
const jsonOut = has('json');
const only = flag('only');
const scope = args.filter((a) => !a.startsWith('--')).map((p) => resolve(REPO, p));

const findings = [];
const report = (severity, check, file, line, message) => {
  if (only && check !== only) return;
  findings.push({ severity, check, file: relative(REPO, file), line, message });
};

const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.mdx?$/.test(entry.name)) out.push(full);
  }
  return out;
};

// ---------------------------------------------------------------------------
// Version routing, read out of docusaurus.config.js
// ---------------------------------------------------------------------------

const config = readFileSync(join(SITE, 'docusaurus.config.js'), 'utf8');
const versionNames = JSON.parse(readFileSync(join(SITE, 'versions.json'), 'utf8'));
const lastVersion = (config.match(/lastVersion:\s*['"]([^'"]+)['"]/) || [])[1];

// A version's route prefix: an explicit `path`, else '' for lastVersion, else its name.
const pathOverride = (key) => {
  const block = config.match(new RegExp(`['"]?${key.replace(/\./g, '\\.')}['"]?\\s*:\\s*\\{([^}]*)\\}`));
  return block ? (block[1].match(/path:\s*['"]([^'"]+)['"]/) || [])[1] : undefined;
};

const versions = [];
versions.push({
  name: 'current',
  root: CURRENT,
  prefix: pathOverride('current') ?? (lastVersion ? 'next' : ''),
});
for (const name of versionNames) {
  const root = join(VERSIONED, `version-${name}`);
  if (!existsSync(root)) continue;
  versions.push({ name, root, prefix: pathOverride(name) ?? (name === lastVersion ? '' : name) });
}

const rootToVersion = new Map(versions.map((v) => [v.root, v]));

// ---------------------------------------------------------------------------
// Route map
// ---------------------------------------------------------------------------

const frontmatter = (text) => {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = {};
  for (const rawLine of m[1].split(/\r?\n/)) {
    const kv = rawLine.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return fm;
};

// Docusaurus doc slug: the file path relative to the version root, with the
// frontmatter `id` substituted for the filename; index/README map to their dir.
const slugFor = (file, root, fm) => {
  const rel = relative(root, file).replace(/\.mdx?$/, '');
  const dir = dirname(rel) === '.' ? '' : dirname(rel);
  const base = basename(rel);
  if (fm.slug) {
    return fm.slug.startsWith('/') ? fm.slug.slice(1) : posix.normalize(posix.join(dir, fm.slug));
  }
  if (base === 'index' || base === 'README') return dir;
  return posix.join(dir, fm.id || base);
};

// A doc's *id* — what sidebars.js addresses it by. Distinct from its slug,
// which is what links resolve against and which frontmatter can override.
const docIdFor = (file, root, fm) => {
  const rel = relative(root, file).replace(/\.mdx?$/, '');
  const dir = dirname(rel) === '.' ? '' : dirname(rel);
  return posix.join(dir, fm.id || basename(rel));
};

const trim = (r) => r.replace(/^\/+|\/+$/g, '');
const withPrefix = (prefix, slug) => trim(prefix ? `${prefix}/${slug}` : slug);

const routes = new Map(); // route -> file
const filesByVersion = new Map();

for (const version of versions) {
  if (!existsSync(version.root)) continue;
  const files = walk(version.root);
  filesByVersion.set(version.name, files);
  for (const file of files) {
    const fm = frontmatter(readFileSync(file, 'utf8'));
    const add = (slug) => {
      const route = withPrefix(version.prefix, slug);
      if (!routes.has(route)) routes.set(route, file);
    };
    add(slugFor(file, version.root, fm));
  }
}

// Redirect sources are valid link targets too.
for (const m of config.matchAll(/from:\s*['"]([^'"]+)['"]/g)) {
  const from = m[1];
  if (from.startsWith('/docs/')) routes.set(trim(from.slice('/docs/'.length)), null);
}

// ---------------------------------------------------------------------------
// Anchors — github-slugger rules (spaces map 1:1 to hyphens, no collapsing)
// ---------------------------------------------------------------------------

const slugify = (heading) =>
  heading
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_~]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, '')
    .replace(/ /g, '-');

const anchorCache = new Map();
const anchorsOf = (file) => {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const set = new Set();
  const text = stripCode(readFileSync(file, 'utf8'));
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (!h) continue;
    const explicit = h[1].match(/\{#([^}]+)\}\s*$/);
    set.add(explicit ? explicit[1] : slugify(h[1].replace(/\{#[^}]+\}\s*$/, '')));
  }
  for (const m of text.matchAll(/(?:\bid|\bname)=["']([^"']+)["']/g)) set.add(m[1]);
  anchorCache.set(file, set);
  return set;
};

// ---------------------------------------------------------------------------
// Link extraction — fenced and inline code is blanked so examples aren't flagged
// ---------------------------------------------------------------------------

function stripCode(text) {
  return text
    .replace(/^```[\s\S]*?^```/gm, (b) => b.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (b) => ' '.repeat(b.length));
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

const targetsIn = (text) => {
  const found = [];
  for (const m of text.matchAll(/(!?)\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g))
    found.push({ url: m[2], index: m.index, image: m[1] === '!' });
  for (const m of text.matchAll(/\bsrc=["']([^"']+)["']/g))
    found.push({ url: m[1], index: m.index, image: true });
  for (const m of text.matchAll(/\bhref=["']([^"']+)["']/g))
    found.push({ url: m[1], index: m.index, image: false });
  return found;
};

// Longest matching version prefix for an unversioned-or-versioned /docs/ route.
const prefixes = versions
  .map((v) => v.prefix)
  .filter((p) => p)
  .sort((a, b) => b.length - a.length);

const knownVersionRoute = (route) => prefixes.some((p) => route === p || route.startsWith(p + '/'));

const checkFile = (file) => {
  const raw = readFileSync(file, 'utf8');
  const text = stripCode(raw);
  const version = rootToVersion.get([...rootToVersion.keys()].find((r) => file.startsWith(r + '/')));

  for (const { url, index, image } of targetsIn(text)) {
    const line = lineOf(raw, index);

    if (/^(https?:|mailto:|tel:|slack:)/.test(url)) continue;

    if (url.startsWith('#')) {
      const anchor = decodeURIComponent(url.slice(1));
      if (anchor && !anchorsOf(file).has(anchor))
        report('warning', 'anchor', file, line, `no heading on this page matches "#${anchor}"`);
      continue;
    }

    const [pathPart, hash] = url.split('#');

    if (image || /\.(png|jpe?g|gif|svg|webp|mp4|pdf)$/i.test(pathPart)) {
      if (!pathPart.startsWith('/')) continue; // relative asset paths are not used here
      if (!existsSync(join(STATIC, pathPart))) {
        // A case-only mismatch resolves on macOS and 404s in production.
        const dir = join(STATIC, dirname(pathPart));
        const wanted = basename(pathPart).toLowerCase();
        const sibling = existsSync(dir) && readdirSync(dir).find((n) => n.toLowerCase() === wanted);
        report('error', 'asset', file, line, sibling
          ? `asset ${pathPart} differs only in case from the file on disk (${sibling}) — this 404s on a case-sensitive host`
          : `missing asset ${pathPart} (expected docs/static${pathPart})`);
      }
      continue;
    }

    let route;
    if (pathPart.startsWith('/docs/') || pathPart === '/docs') {
      route = trim(pathPart.replace(/^\/docs/, ''));
      if (!route) continue; // the docs home page
    } else if (pathPart.startsWith('./') || pathPart.startsWith('../')) {
      const abs = resolve(dirname(file), pathPart.replace(/\.mdx?$/, ''));
      route = withPrefix(version.prefix, trim(relative(version.root, abs)));
    } else if (pathPart.startsWith('/')) {
      continue; // a non-docs site route (landing pages, blog, ...)
    } else {
      continue; // bare text, not a path
    }

    // /docs/category/* routes come from generated-index sidebar entries.
    if (route === 'category' || route.startsWith('category/')) continue;

    // An unprefixed /docs/ link resolves to `lastVersion`, not to the current
    // docs the author is editing — so the same path can drift between them.
    const current = versions.find((v) => v.name === 'current');
    const currentRoute = knownVersionRoute(route) ? null : withPrefix(current.prefix, route);

    const target = routes.get(route);
    if (target === undefined) {
      if (currentRoute && routes.has(currentRoute))
        report('error', 'cross-version', file, line,
          `${pathPart} resolves to the ${lastVersion} docs, where the page does not exist — link /docs/${currentRoute} or add the page to versioned_docs/version-${lastVersion}`);
      else
        report('error', 'link', file, line, `broken doc link ${pathPart} — no page resolves to /docs/${route}`);
      continue;
    }

    if (hash && target) {
      const anchor = decodeURIComponent(hash);
      if (anchorsOf(target).has(anchor)) continue;
      const counterpart = currentRoute && routes.get(currentRoute);
      if (counterpart && counterpart !== target && anchorsOf(counterpart).has(anchor))
        report('warning', 'cross-version', file, line,
          `${pathPart}#${anchor} exists in the current docs, but this link resolves to the ${lastVersion} page, which has no such heading`);
      else
        report('warning', 'anchor', file, line, `${pathPart} exists but has no heading "#${anchor}"`);
    }
  }
};

const checked = checkAll
  ? [...filesByVersion.values()].flat()
  : filesByVersion.get('current') ?? [];
for (const file of checked) checkFile(file);

// ---------------------------------------------------------------------------
// Sidebar entries must point at real docs (a missing one fails the build)
// ---------------------------------------------------------------------------

const currentVersion = versions.find((v) => v.name === 'current');
const currentIds = new Set(
  (filesByVersion.get('current') ?? []).map((f) =>
    docIdFor(f, currentVersion.root, frontmatter(readFileSync(f, 'utf8'))))
);

const sidebarPath = join(SITE, 'sidebars.js');
const sidebarSource = readFileSync(sidebarPath, 'utf8');
const referenced = [];
const collectIds = (node) => {
  if (typeof node === 'string') referenced.push(node);
  else if (Array.isArray(node)) node.forEach(collectIds);
  else if (node && typeof node === 'object') {
    if (typeof node.id === 'string' && node.type !== 'link') referenced.push(node.id);
    if (node.items) collectIds(node.items);
    if (node.link && node.link.type === 'doc') collectIds(node.link.id);
  }
};

try {
  const sidebarModule = createRequire(import.meta.url)(sidebarPath);
  for (const sidebar of Object.values(sidebarModule)) collectIds(sidebar);
  for (const id of new Set(referenced)) {
    if (currentIds.has(id)) continue;
    const at = sidebarSource.match(new RegExp(`['\"]${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['\"]`));
    report('error', 'sidebar', sidebarPath, at ? lineOf(sidebarSource, at.index) : 1,
      `sidebar references "${id}" but no page in docs/docs has that id`);
  }
} catch (err) {
  report('warning', 'sidebar', sidebarPath, 1, `could not load sidebars.js: ${err.message}`);
}

// ---------------------------------------------------------------------------
// Documented environment variables vs .env.example
// ---------------------------------------------------------------------------

const envDoc = join(CURRENT, 'setup/env-vars.md');
const envExample = join(REPO, '.env.example');
if (existsSync(envDoc) && existsSync(envExample)) {
  const declared = new Set(
    [...readFileSync(envExample, 'utf8').matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]{2,})\s*=/gm)].map((m) => m[1])
  );
  const seen = new Set();
  readFileSync(envDoc, 'utf8').split(/\r?\n/).forEach((line, i) => {
    const row = line.match(/^\|\s*`?([A-Z][A-Z0-9_]{2,})`?\s*\|/);
    const name = row && row[1];
    if (!name || seen.has(name) || declared.has(name)) return;
    seen.add(name);
    report('warning', 'env', envDoc, i + 1, `${name} is documented but absent from .env.example`);
  });
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

let out = findings;
if (scope.length)
  out = out.filter((f) => scope.some((s) => {
    const abs = resolve(REPO, f.file);
    return abs === s || abs.startsWith(s + '/');
  }));
out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

if (jsonOut) {
  console.log(JSON.stringify(out, null, 2));
} else {
  for (const f of out)
    console.log(`${f.severity === 'error' ? 'ERROR  ' : 'warning'} ${f.file}:${f.line}  [${f.check}] ${f.message}`);
  const errors = out.filter((f) => f.severity === 'error').length;
  console.log(`\nversions: ${versions.map((v) => `${v.name} -> /docs/${v.prefix}`).join(', ')}`);
  console.log(`${checked.length} pages checked — ${errors} error(s), ${out.length - errors} warning(s)`);
}

process.exit(out.some((f) => f.severity === 'error') ? 1 : 0);
