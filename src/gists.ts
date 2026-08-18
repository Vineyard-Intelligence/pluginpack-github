// Gists — an account's public snippets, one URL node each.
//
// NO endpoint.file NODES, deliberately. That type is labelled by its file name, and gist file names
// are overwhelmingly generic: across seven accounts, 542 gist files carried only 392 distinct names,
// and `gistfile1.txt` alone appeared 95 times spanning six of the seven owners. Since a node's
// identity is its type plus its label, one `gistfile1.txt` node would fuse six unrelated subjects
// into a single entity and put arbitrary pairs of them two hops apart. The gist's own URL is unique
// by construction, so the file names ride along as a property instead.
import { definePlugin } from './sdk';
import type { HostContext, RunResult } from './sdk';
import { GH_PLATFORM, rest, loginOf, abortIf } from './gh';

export const gists = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.github_gists',
        content_type: 'vineyard:plugin',
        name: 'GitHub Gists',
        version: '1.0.0',
        description:
            'Collects an account\'s public gists as URL nodes, carrying the file names, languages, description and dates as properties. Gists are where configuration fragments, scratch scripts and pasted output tend to end up, so they often hold detail the account\'s repositories do not.',
        icon: 'file-code',
        author: { name: 'VINEYARD', url: 'https://vineyard.run' },
        license: 'Apache-2.0',
        platforms: {
            primary: 'web',
            web: { runtime: 'sandbox-js', entry: 'dist/pack.mjs' },
            desktop: { runtime: 'sandbox-js', entry: 'dist/pack.mjs', min_app_version: '0.1.0' },
        },
        io: {
            consumes: [
                { typepack: 'run.vineyard.typepacks.identity', category: 'identity', name: 'account' },
                { typepack: 'run.vineyard.typepacks.identity', category: 'identity', name: 'handle' },
                { typepack: 'run.vineyard.typepacks.infrastructure', category: 'web', name: 'url' },
            ],
            produces: [{ typepack: 'run.vineyard.typepacks.infrastructure', category: 'web', name: 'url' }],
        },
        params: {
            type: 'object',
            properties: {
                max_gists: {
                    type: 'integer',
                    title: 'Maximum gists per account',
                    default: 300,
                    minimum: 1,
                    maximum: 3000,
                    description: 'Read in pages of 100. Most accounts hold far fewer than this.',
                },
            },
        },
        scopes: {
            graph: ['node:read', 'node:create', 'edge:create'],
            network: [
                {
                    endpoint: 'https://api.github.com/users',
                    methods: ['GET'],
                    purpose: 'List the public gists of the selected account.',
                },
            ],
            config: [
                {
                    key: 'token',
                    label: 'GitHub personal access token',
                    type: 'string',
                    secret: true,
                    scope: 'user',
                    optional: false,
                },
            ],
        },
        lifecycle: { persistence: 'opt-in', controls: ['progress', 'cancel'], progress: 'determinate' },
    },

    async run(ctx: HostContext): Promise<RunResult> {
        const ids = ctx.input.selection;
        if (!ids.length) return { summary: 'Select a GitHub account first', counts: {} };
        const cap = Math.max(1, Math.min(3000, Number(ctx.params?.max_gists ?? 300)));

        let created = 0;
        let reached = 0;
        let skipped = 0;
        let capped = 0;

        for (let i = 0; i < ids.length; i++) {
            if (abortIf(ctx)) break;
            const seed = await ctx.graph!.get!(ids[i]);
            if (!seed) {
                skipped++;
                continue;
            }
            const login = loginOf(seed);
            if (!login) {
                skipped++;
                continue;
            }
            reached++;
            ctx.progress?.set?.({
                percent: Math.round((100 * i) / ids.length),
                message: `${login} (${i + 1}/${ids.length})`,
            });

            const rowsAll: any[] = [];
            for (let page = 1; rowsAll.length < cap; page++) {
                const rows = await rest(ctx, `/users/${encodeURIComponent(login)}/gists?per_page=100&page=${page}`);
                if (!Array.isArray(rows) || !rows.length) break;
                rowsAll.push(...rows);
                if (rows.length < 100) break;
                if (page >= 30) break;
            }
            if (rowsAll.length > cap) capped++;
            const rows = rowsAll.slice(0, cap);
            if (!rows.length) continue;

            // Anchor on an account node so the gists have an owner.
            let owner = String(seed.id);
            if (seed.type !== 'identity.account') {
                const acct = await ctx.graph!.createNode!({
                    type: 'identity.account',
                    data: { username: login, platform: GH_PLATFORM, profile_url: `https://github.com/${login}` },
                });
                owner = String(acct.id);
                if (owner !== String(seed.id)) {
                    await ctx.graph!.createEdge!({ from: String(seed.id), to: owner, label: 'github account' });
                }
            }

            for (const g of rows) {
                if (!g?.html_url) continue;
                const files = Object.values(g.files ?? {}) as any[];
                const node = await ctx.graph!.createNode!({
                    type: 'web.url',
                    data: {
                        url: String(g.html_url),
                        title: String(g.description || `gist ${g.id ?? ''}`).slice(0, 200),
                        // File names are PROPERTIES, never nodes — see the note at the top.
                        file_names: files.map((f) => f?.filename).filter(Boolean).join(', ').slice(0, 500),
                        languages: [...new Set(files.map((f) => f?.language).filter(Boolean))].join(', '),
                        file_count: files.length,
                        created_at: g.created_at,
                        updated_at: g.updated_at,
                    },
                });
                created++;
                await ctx.graph!.createEdge!({ from: owner, to: String(node.id), label: 'published this gist' });
            }
        }

        if (!reached) {
            throw new Error(
                `None of the ${ids.length} selected node(s) name a GitHub account — select an Account, ` +
                    `Handle, or https://github.com/<login> URL.`,
            );
        }

        return {
            summary: `${created} gist(s) from ${reached} account(s)${capped ? ` — ${capped} account(s) hit the cap` : ''}${skipped ? ` — ${skipped} skipped` : ''}`,
            counts: { gists: created, accounts: reached, capped, skipped },
        };
    },
});
