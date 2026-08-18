// Pages Custom Domain — the domain a repository actually publishes on.
//
// One request per repository, and the only edge in this pack that leaves GitHub entirely: from a
// repository to a domain the existing DNS, certificate and IP plugins can carry on from.
//
// 404 IS A REAL ANSWER HERE, not a failure: it is what a repository without a Pages site returns.
// Anything else — 401, 403, a transport error — is raised, because those are the states an empty
// result would otherwise be mistaken for. Without a token the endpoint answers 404 even for
// repositories that DO publish a site, which is why this plugin cannot run unauthenticated at all.
import { definePlugin } from './sdk';
import type { HostContext, RunResult } from './sdk';
import { API, ghToken, repoOf, abortIf } from './gh';

export const pagesDomain = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.github_pages_domain',
        content_type: 'vineyard:plugin',
        name: 'GitHub Pages Domain',
        version: '1.0.0',
        description:
            'Checks whether each selected repository publishes a GitHub Pages site and, when it does, adds the domain it serves on as a node linked to the repository. This is the step that takes an investigation off GitHub: the resulting domain is the input the DNS, certificate and address plugins already know how to follow.',
        icon: 'globe',
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
                { typepack: 'run.vineyard.typepacks.infrastructure', category: 'infrastructure', name: 'domain' },
                { typepack: 'run.vineyard.typepacks.infrastructure', category: 'web', name: 'url' },
            ],
        },
        scopes: {
            graph: ['node:read', 'node:create', 'edge:create'],
            network: [
                {
                    endpoint: 'https://api.github.com/repos',
                    methods: ['GET'],
                    purpose: 'Read the GitHub Pages configuration of the selected repository.',
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
        const token = ghToken(ctx);

        let domains = 0;
        let sites = 0;
        let none = 0;
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

            const res = await ctx.net!.fetch!(`${API}/repos/${repo.owner}/${repo.name}/pages`, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                },
            });

            // The one status that means "asked and answered, nothing here".
            if (res.status === 404) {
                none++;
                continue;
            }
            if (!res.ok) {
                throw new Error(
                    `GitHub Pages lookup for ${repo.owner}/${repo.name} failed: HTTP ${res.status}. ` +
                        `A 401 or 403 means the token is missing or lacks access — not that the repository has no site.`,
                );
            }
            const info = JSON.parse(await res.text());
            sites++;

            const siteUrl = typeof info?.html_url === 'string' ? info.html_url : '';
            const custom = typeof info?.cname === 'string' && info.cname ? info.cname : '';
            const host = custom || (() => {
                try {
                    return new URL(siteUrl).hostname;
                } catch {
                    return '';
                }
            })();

            if (host) {
                const dom = await ctx.graph!.createNode!({
                    type: 'infrastructure.domain',
                    data: { domain_name: host.toLowerCase() },
                });
                domains++;
                await ctx.graph!.createEdge!({
                    from: String(seed.id),
                    to: String(dom.id),
                    label: custom ? 'publishes a GitHub Pages site on this custom domain' : 'publishes a GitHub Pages site on this domain',
                });
            }
            if (siteUrl) {
                const su = await ctx.graph!.createNode!({
                    type: 'web.url',
                    data: { url: siteUrl, title: `${repo.owner}/${repo.name} Pages site` },
                });
                await ctx.graph!.createEdge!({ from: String(seed.id), to: String(su.id), label: 'published site' });
            }
        }

        if (!reached) {
            throw new Error(
                `None of the ${ids.length} selected node(s) is a GitHub repository URL — select nodes ` +
                    `whose url looks like https://github.com/<owner>/<repo>.`,
            );
        }

        return {
            summary: `${sites} Pages site(s), ${domains} domain(s) across ${reached} repositor${reached === 1 ? 'y' : 'ies'} — ${none} publish nothing`,
            counts: { sites, domains, no_site: none, repositories: reached, skipped },
        };
    },
});
