---
name: verify
description: Verify that ToolJet's documentation still matches the code and the site's own routing — broken doc links, missing or case-mismatched images, sidebar entries pointing at nothing, environment variables that drifted from .env.example, and stale commands or version numbers. Use when docs under docs/ were touched, before shipping a docs PR, or when asked to check whether the documentation is accurate or up to date.
---

# Verify documentation accuracy

Docs in this repo go stale silently: `docs/docusaurus.config.js` sets
`onBrokenLinks: 'ignore'`, so a build never fails on a dead link. This skill
finds the drift the build won't.

## Step 1 — run the mechanical checks

```bash
node .claude/skills/verify/check_docs.mjs
```

Add paths to report only on files you touched, which is the normal mode when
reviewing a change:

```bash
node .claude/skills/verify/check_docs.mjs docs/docs/setup docs/docs/widgets/table
```

Useful flags: `--only=<check>` (`link`, `anchor`, `asset`, `sidebar`, `env`,
`cross-version`), `--json` for machine-readable output, `--all` to include the
frozen `versioned_docs/` snapshots (off by default — see below). Exit status is
non-zero when there is at least one error.

**Errors** are things that are broken on the live site: a link that 404s, a
missing image, a sidebar entry with no page behind it. **Warnings** need
judgment — a missing heading anchor, a documented env var that is not in
`.env.example`.

## Step 2 — check what a script cannot

Read the pages the change touches and confirm against the actual source:

- **Commands and scripts.** Every `npm run …` in a doc should exist in the
  relevant `package.json` (root, `server/`, `frontend/`, `docs/`). Same for
  `docker compose` service names against `docker-compose.yaml`.
- **Environment variables.** Confirm the variable is actually read in the
  source (`grep -rn "process.env.VAR_NAME" server/src frontend/src`) and that
  the documented default matches. The script only compares names against
  `.env.example`; it cannot tell you the description went stale.
- **Version numbers.** Compare claims against `.version`, `docs/versions.json`,
  and the `engines` block in `package.json` (Node and npm versions are
  documented in the setup guides and drift often).
- **Code samples and API shapes.** Check payloads, endpoint paths, and option
  names against the controllers and components they describe.
- **Screenshots.** A screenshot showing UI that no longer exists is stale even
  though the file resolves — flag it, don't silently keep it.

## How docs routing actually works here

Get this wrong and you will "fix" links that were fine. From
`docs/docusaurus.config.js`:

| Source tree | Served at |
| --- | --- |
| `docs/docs/` (current, labelled 3.1.0-Beta) | `/docs/beta/…` |
| `docs/versioned_docs/version-3.0.0-LTS/` (`lastVersion`) | `/docs/…` |
| `docs/versioned_docs/version-2.50.0-LTS/` | `/docs/2.50.0-LTS/…` |

So **an unprefixed `/docs/foo` link resolves to the 3.0.0-LTS snapshot, not to
the page next to it in `docs/docs/`.** That is what the `cross-version` check
reports: the target exists in the current docs but not in the version the link
actually lands on. These are usually not worth mass-fixing — the whole site
links unprefixed by convention. Fix one only when the linked anchor or page is
genuinely new and the reader would land somewhere wrong.

Two more routing rules the checker encodes, worth knowing when reading its output:

- **`id` and `slug` are different things.** `sidebars.js` addresses pages by
  document *id*; links resolve against *slug*. `docs/docs/widgets/table/properties.md`
  has `id: table-properties` and `slug: /widgets/table/`, so the sidebar says
  `widgets/table/table-properties` while links say `/docs/widgets/table/`. Both
  are correct.
- **`/docs/category/…` routes** are generated from `generated-index` entries in
  `sidebars.js`, not from files. The checker skips them.

## Fixing what you find

- Fix forward in `docs/docs/`. **Do not edit `docs/versioned_docs/`** — those
  are frozen published snapshots. `--all` is for auditing them, not repairing
  them; if a released version has a broken link, say so and let a maintainer
  decide.
- Prefer repointing a link over deleting it. A link to a page that moved should
  point at the new page; only drop it when the content is genuinely gone.
- Asset paths are case-sensitive in production even though they resolve on
  macOS. When the checker reports a case-only mismatch, fix the reference in the
  doc to match the file on disk rather than renaming the image.
- Re-run the checker scoped to the files you changed and confirm the finding is
  gone.

## Reporting

Lead with what is broken on the live site (errors), then the judgment items,
then anything you deliberately left alone and why. Give `file:line` for each so
they are clickable. If you verified a claim and it holds, say so plainly rather
than staying silent — "checked, still accurate" is a useful result.
