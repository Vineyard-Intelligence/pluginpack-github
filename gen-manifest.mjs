#!/usr/bin/env node
/**
 * Emit plugins/github.manifest.json from the BUILT bundle.
 *
 * The manifest and the code it describes are two copies of the same declaration — scopes, io,
 * params, versions — and hand-maintaining the JSON is how they drift: the registry pins a commit,
 * the client reads the manifest from it, and a scope the code needs but the JSON forgot fails at
 * run time with nothing pointing at the cause. Generating it means the JSON cannot disagree.
 *
 * Usage: node gen-manifest.mjs   (after build.mjs)
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pack = (await import(join(here, 'dist', 'pack.mjs'))).default;

if (!pack?.plugins?.length) {
    console.error('dist/pack.mjs has no plugins — run build.mjs first');
    process.exit(1);
}

/** The pack-level block every member repeats. `entry` must be the bundle path, never "inline":
 *  a member declaring "inline" installs without error and then never appears in the plugin list. */
const platforms = {
    primary: 'web',
    web: { runtime: 'sandbox-js', entry: 'dist/pack.mjs' },
    desktop: { runtime: 'sandbox-js', entry: 'dist/pack.mjs', min_app_version: '0.1.0' },
};

/** `author` and `license` are pack-level only — the member schema rejects them, and repeating them
 *  on every plugin would say nothing the pack has not already said. */
function member(m) {
    const { author, license, ...rest } = m;
    // A plugin may narrow its own platforms — Code Search is desktop-only because GitHub omits the
    // CORS header from authenticated code-search responses, which only the shell's waiver fixes.
    return { ...rest, platforms: m.platforms ?? platforms };
}

const manifest = {
    identifier: pack.identifier,
    content_type: 'vineyard:pluginpack',
    name: pack.name,
    version: pack.version,
    description: pack.description,
    author: { name: 'VINEYARD', url: 'https://github.com/Vineyard-Intelligence' },
    license: 'Apache-2.0',
    icon: 'github',
    platforms,
    distribution: {
        kind: 'git',
        repository: 'https://github.com/Vineyard-Intelligence/pluginpack-github',
        ref: `v${pack.version}`,
        path: 'plugins/github.manifest.json',
    },
    plugins: pack.plugins.map((p) => member(p.manifest)),
};

const out = join(here, 'plugins', 'github.manifest.json');
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote plugins/github.manifest.json (${manifest.plugins.length} plugins)`);
