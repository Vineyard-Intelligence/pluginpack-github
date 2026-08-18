// Code Search — search every public repository on GitHub for a string.
//
// Takes no input node: it runs from the graph toolbar with a query, and turns matches into the
// repositories and accounts behind them.
//
// DESKTOP ONLY, and the reason is specific rather than general. GitHub answers
// `access-control-allow-origin: *` on every other endpoint this pack uses — including the same
// search API for repositories and users — but omits it from AUTHENTICATED code-search responses.
// Measured both ways: the keyless 401 carries the header, the authenticated 200 does not. So a
// browser throws away a response the server did send.
//
// The desktop shell fixes exactly this, and does it through the manifest rather than through any
// code here: the renderer collects each installed plugin's declared `network` endpoints, publishes
// their ORIGINS to the main process, and the shell then strips `Origin` on the way out and writes
// `Access-Control-Allow-Origin` on the way back for those origins only. The request GitHub sees is
// therefore identical to an ordinary API call from a script — which is why this works at all.
//
// WHAT THE RESULT IS NOT. Code search reads default branches of indexed repositories and stops at
// 1,000 results however many exist. So a miss is not evidence of absence, and this plugin says so
// in its summary rather than leaving a reader to infer a clean negative from an empty graph — the
// exact wrong conclusion for the query people most often run here, which is "did my key leak".
import { definePlugin } from './sdk';
import type { HostContext, RunResult } from './sdk';
import { GH_PLATFORM, API, ghToken, abortIf } from './gh';

/** GitHub refuses page 11 outright: "Cannot access beyond the first 1000 results" (HTTP 422). */
const HARD_CAP = 1000;
const PER_PAGE = 100;

export const codeSearch = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.github_code_search',
        content_type: 'vineyard:plugin',
        name: 'GitHub Code Search',
        version: '1.1.0',
        description:
            'Searches the code of every public repository GitHub has indexed and turns the matches into repository and account nodes. Runs from a query rather than from a selected node. GitHub caps this at 1,000 results no matter how many exist and only searches default branches of indexed repositories, so narrow the query with user:, org: or repo: until the reported total is under a thousand — and read an empty result as "not found in what was searched", never as "not on GitHub". Desktop only: GitHub omits the CORS header from authenticated code-search responses specifically, so a browser cannot read them.',
        icon: 'search-code',
        author: { name: 'VINEYARD', url: 'https://vineyard.run' },
        license: 'Apache-2.0',
        platforms: {
            primary: 'desktop',
            desktop: { runtime: 'sandbox-js', entry: 'dist/pack.mjs', min_app_version: '0.1.0' },
        },
        io: {
            // Empty consumes => whole-graph plugin: launched globally, with no selection.
            consumes: [],
            produces: [
                { typepack: 'run.vineyard.typepacks.infrastructure', category: 'web', name: 'url' },
                { typepack: 'run.vineyard.typepacks.identity', category: 'identity', name: 'account' },
            ],
        },
        params: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    title: 'Search query',
                    minLength: 1,
                    description:
                        'GitHub code search syntax. Scope it or the 1,000-result cap makes the answer arbitrary: "AKIA" user:someone · "internal.example.com" org:acme · filename:.env "API_KEY" · extension:tf "access_key".',
                },
                max_results: {
                    type: 'integer',
                    title: 'Maximum results',
                    default: 300,
                    minimum: 1,
                    maximum: 1000,
                    description: 'GitHub will not return more than 1,000 for any query, whatever the total says.',
                },
            },
            required: ['query'],
        },
        scopes: {
            graph: ['node:read', 'node:create', 'edge:create'],
            network: [
                {
                    endpoint: 'https://api.github.com/search',
                    methods: ['GET'],
                    purpose: 'Search public repository code for the query you enter.',
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
        const query = String(ctx.params?.query ?? '').trim();
        if (!query) throw new Error('Enter a search query first.');
        const want = Math.max(1, Math.min(HARD_CAP, Number(ctx.params?.max_results ?? 300)));
        const token = ghToken(ctx);

        const items: any[] = [];
        let total = 0;
        const pages = Math.ceil(want / PER_PAGE);

        for (let page = 1; page <= pages; page++) {
            if (abortIf(ctx)) break;
            ctx.progress?.set?.({ percent: Math.round((100 * (page - 1)) / pages), message: `Searching (page ${page}/${pages})` });

            let res;
            try {
                res = await ctx.net!.fetch!(
                    `${API}/search/code?q=${encodeURIComponent(query)}&per_page=${PER_PAGE}&page=${page}`,
                    {
                        method: 'GET',
                        headers: {
                            Authorization: `Bearer ${token}`,
                            Accept: 'application/vnd.github+json',
                            'X-GitHub-Api-Version': '2022-11-28',
                        },
                    },
                );
            } catch (e: any) {
                // On the web build the response arrives without a CORS header and fetch rejects
                // before any status is visible. Naming the cause beats "Failed to fetch".
                throw new Error(
                    'GitHub code search could not be read. This plugin needs the Vineyard desktop app: ' +
                        'GitHub omits the CORS header from authenticated code-search responses, so a browser ' +
                        `discards them. (${e?.message ?? e})`,
                );
            }

            if (res.status === 422) break; // past the 1,000-result wall
            if (!res.ok) {
                const body = await res.text();
                let msg = body.slice(0, 200);
                try {
                    msg = JSON.parse(body)?.message ?? msg;
                } catch {
                    /* keep the prefix */
                }
                throw new Error(`GitHub code search failed: HTTP ${res.status} — ${msg}`);
            }

            const j = JSON.parse(await res.text());
            total = Number(j?.total_count ?? 0);
            const batch = j?.items ?? [];
            items.push(...batch);
            if (batch.length < PER_PAGE) break;
            if (items.length >= want) break;
        }

        const taken = items.slice(0, want);
        if (!taken.length) {
            // An empty result is reported, not thrown — the search DID run. The wording is the
            // point: this host paints a normal return green, so the summary has to carry the
            // limitation rather than leave "no nodes" to speak for itself.
            return {
                summary:
                    `No matches for "${query}" in what GitHub searched — default branches of indexed ` +
                    `repositories only. That is not the same as "not on GitHub".`,
                counts: { matches: 0, total_reported: total },
            };
        }

        // One node per repository and per owner — never per match path, and never the query itself.
        // A search string as a node would be a hub linked to everything it ever matched, and a file
        // node keyed on a name like ".env" would fuse every unrelated repository that has one.
        const repoSeen = new Map<string, string>();
        const ownerSeen = new Map<string, string>();
        let repos = 0;
        let owners = 0;
        let matches = 0;

        for (const it of taken) {
            if (abortIf(ctx)) break;
            const full = it?.repository?.full_name;
            const repoUrl = it?.repository?.html_url;
            const login = it?.repository?.owner?.login;
            if (!full || !repoUrl) continue;

            let repoId = repoSeen.get(full);
            if (!repoId) {
                const n = await ctx.graph!.createNode!({
                    type: 'web.url',
                    data: { url: String(repoUrl), title: String(full), matched_query: query },
                });
                repoId = String(n.id);
                repoSeen.set(full, repoId);
                repos++;
            }

            if (login && !ownerSeen.has(login)) {
                const a = await ctx.graph!.createNode!({
                    type: 'identity.account',
                    data: {
                        username: String(login),
                        platform: GH_PLATFORM,
                        user_id: it?.repository?.owner?.id != null ? String(it.repository.owner.id) : undefined,
                        profile_url: `https://github.com/${login}`,
                    },
                });
                ownerSeen.set(login, String(a.id));
                owners++;
                await ctx.graph!.createEdge!({ from: String(a.id), to: repoId, label: 'owns repository' });
            }

            if (it?.html_url && it?.path) {
                const m = await ctx.graph!.createNode!({
                    type: 'web.url',
                    data: { url: String(it.html_url), title: String(it.path), matched_query: query },
                });
                matches++;
                await ctx.graph!.createEdge!({
                    from: String(m.id),
                    to: repoId,
                    label: `matched "${query.slice(0, 120)}" in this repository`,
                });
            }
        }

        const capped = total > taken.length;
        return {
            summary:
                `${matches} match(es) in ${repos} repositor${repos === 1 ? 'y' : 'ies'} from ${owners} account(s)` +
                (capped
                    ? ` — GitHub reports ${total.toLocaleString()} total but returns at most ${HARD_CAP.toLocaleString()}; narrow the query with user:, org: or repo: to see a representative set`
                    : ''),
            counts: { matches, repositories: repos, accounts: owners, retrieved: taken.length, total_reported: total },
        };
    },
});
