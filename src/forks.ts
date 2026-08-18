// Forks With Own Commits — the people who took a copy of a repository and then worked on it.
//
// The filter is the point. Forking is one click and most forks are never touched: across 500 forks
// of a busy repository, only 42% had been pushed to after creation, and that share falls the deeper
// you page. An untouched fork asserts nothing about its owner, and materialising ten thousand of
// them would put arbitrary pairs of unrelated subjects two hops apart through the upstream project.
// `pushed_at > created_at` keeps the ones where somebody actually did something.
//
// This is NOT redundant with Commit Identities, and measurement says so: of the fork owners it
// returns, only 7.8% also appear in the upstream repository's commit history. Work done in a fork
// stays in that fork unless a pull request is merged, so these are, almost entirely, people the
// upstream commit walk structurally cannot see.
//
// Its output is a lead rather than a finding: an account and the URL of their fork. The identity
// behind it comes from running Commit Identities on that fork, which is why the fork URL is a node.
import { definePlugin } from './sdk';
import type { HostContext, RunResult } from './sdk';
import { ghToken, GH_PLATFORM, restPaged, lastPage, rest, repoOf, abortIf } from './gh';

export const forksWithCommits = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.github_forks',
        content_type: 'vineyard:plugin',
        name: 'GitHub Forks With Own Commits',
        version: '1.1.0',
        description:
            'Finds the forks of a repository that have been pushed to since they were created, and adds each one as a URL node with its owner\'s account. Untouched forks — the large majority — are left out, because a fork button press says nothing about the person who pressed it. Work done in a fork never appears in the upstream history unless a pull request lands, so these owners are mostly people the upstream commit scan cannot reach; run Commit Identities on a fork URL to recover the identity behind it.',
        icon: 'git-fork',
        author: { name: 'VINEYARD', url: 'https://vineyard.run' },
        license: 'Apache-2.0',
        platforms: {
            primary: 'web',
            web: { runtime: 'sandbox-js', entry: 'dist/pack.mjs' },
            desktop: { runtime: 'sandbox-js', entry: 'dist/pack.mjs', min_app_version: '0.1.0' },
        },
        io: {
            consumes: [{ typepack: 'run.vineyard.typepacks.infrastructure', category: 'web', name: 'url' }],
            produces: [
                { typepack: 'run.vineyard.typepacks.infrastructure', category: 'web', name: 'url' },
                { typepack: 'run.vineyard.typepacks.identity', category: 'identity', name: 'account' },
            ],
        },
        params: {
            type: 'object',
            properties: {
                max_forks: {
                    type: 'integer',
                    title: 'Maximum forks to examine',
                    default: 200,
                    minimum: 1,
                    maximum: 5000,
                    description:
                        'How many forks to look at, newest first, in pages of 100. A popular repository can have tens of thousands; what was examined versus what exists is recorded on the repository node.',
                },
                worked_only: {
                    type: 'boolean',
                    title: 'Only forks that were pushed to',
                    default: true,
                    description:
                        'Turning this off adds every fork owner, most of whom only clicked a button. Measured: 58% of forks were never touched after creation.',
                },
            },
        },
        scopes: {
            graph: ['node:read', 'node:create', 'node:update', 'edge:create'],
            network: [
                {
                    endpoint: 'https://api.github.com/repos',
                    methods: ['GET'],
                    purpose: 'List the forks of the selected repository.',
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
        if (!ids.length) return { summary: 'Select a GitHub repository URL first', counts: {} };
        // Token first, before anything about the selection is judged. It is a precondition of the
        // whole run rather than of one node, and when both are wrong "this pack has no token" is the
        // message that lets the analyst act — checking the selection first made the reported problem
        // depend on which node happened to be selected.
        ghToken(ctx);
        const cap = Math.max(1, Math.min(5000, Number(ctx.params?.max_forks ?? 200)));
        const workedOnly = ctx.params?.worked_only !== false;

        let added = 0;
        let examined = 0;
        let untouched = 0;
        let reached = 0;
        let skipped = 0;

        for (let i = 0; i < ids.length; i++) {
            if (abortIf(ctx)) break;
            const seed = await ctx.graph!.get!(ids[i]);
            if (!seed) {
                skipped++;
                continue;
            }
            const repo = repoOf(seed);
            if (!repo) {
                skipped++;
                continue;
            }
            reached++;
            ctx.progress?.set?.({
                percent: Math.round((100 * i) / ids.length),
                message: `${repo.owner}/${repo.name} (${i + 1}/${ids.length})`,
            });

            const first = await restPaged(ctx, `/repos/${repo.owner}/${repo.name}/forks?per_page=100&sort=newest`);
            if (!Array.isArray(first.data)) {
                skipped++;
                continue;
            }
            const totalPages = lastPage(first.link);
            const rows: any[] = [...first.data];
            for (let p = 2; p <= totalPages && rows.length < cap; p++) {
                if (abortIf(ctx)) break;
                const more = await rest(ctx, `/repos/${repo.owner}/${repo.name}/forks?per_page=100&sort=newest&page=${p}`);
                if (!Array.isArray(more) || !more.length) break;
                rows.push(...more);
            }

            const taken = rows.slice(0, cap);
            examined += taken.length;
            const repoNodeId = String(seed.id);

            for (const f of taken) {
                if (!f?.owner?.login || !f?.html_url) continue;
                const worked = String(f.pushed_at ?? '') > String(f.created_at ?? '');
                if (workedOnly && !worked) {
                    untouched++;
                    continue;
                }
                const forkNode = await ctx.graph!.createNode!({
                    type: 'web.url',
                    data: {
                        url: String(f.html_url),
                        title: String(f.full_name ?? ''),
                        is_fork: true,
                        created_at: f.created_at,
                        pushed_at: f.pushed_at,
                    },
                });
                const acct = await ctx.graph!.createNode!({
                    type: 'identity.account',
                    data: {
                        username: String(f.owner.login),
                        platform: GH_PLATFORM,
                        user_id: f.owner.id != null ? String(f.owner.id) : undefined,
                        profile_url: `https://github.com/${f.owner.login}`,
                    },
                });
                added++;
                await ctx.graph!.createEdge!({ from: String(acct.id), to: String(forkNode.id), label: 'owns this fork' });
                // The claim is exactly this and no more: a copy that was worked on. NOT
                // "contributed to the upstream project", which 92% of these owners never did.
                await ctx.graph!.createEdge!({
                    from: String(forkNode.id),
                    to: repoNodeId,
                    label: worked ? 'forked from, and pushed to since' : 'forked from',
                });
            }

            await ctx.graph!.updateNode!(repoNodeId, {
                forks_examined: taken.length,
                forks_total_pages: totalPages,
            });
        }

        if (!reached) {
            throw new Error(
                `None of the ${ids.length} selected node(s) is a GitHub repository URL — select nodes ` +
                    `whose url looks like https://github.com/<owner>/<repo>.`,
            );
        }

        return {
            summary:
                `${added} fork(s) with own commits from ${examined} examined across ${reached} repositor${reached === 1 ? 'y' : 'ies'}` +
                (untouched ? ` — ${untouched} untouched fork(s) left out` : ''),
            counts: { forks_added: added, examined, untouched, repositories: reached, skipped },
        };
    },
});
