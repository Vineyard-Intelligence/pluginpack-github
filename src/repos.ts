// Account Repositories — expands a GitHub account into the repositories it owns (and, optionally,
// the ones it merely committed to), so the commit-identity plugin has something to run on.
//
// This is the plugin that makes the rest of the pack usable: every other repository-scoped plugin
// consumes a repository URL node, and without this one the analyst would be pasting them by hand.
//
// It also carries the cost signal. The GraphQL query asks each repository for its commit
// totalCount, which is free at this depth and is the number that decides whether scanning it is a
// few requests or a few hundred — the commit plugin has no page cap, so the decision belongs here,
// in front of the analyst, rather than in a silent truncation afterwards.
import { definePlugin } from './sdk';
import type { HostContext, RunResult, GraphNode } from './sdk';
import { GH_PLATFORM, gql, rest, loginOf, abortIf } from './gh';

const PROFILE_QUERY = `query($login:String!,$n:Int!,$after:String){
  repositoryOwner(login:$login){
    __typename
    ... on User {
      login databaseId name email company location websiteUrl createdAt avatarUrl
      organizations(first:20){ nodes{ login name } }
      repositories(first:$n, after:$after, ownerAffiliations:[OWNER], orderBy:{field:PUSHED_AT,direction:DESC}){
        totalCount pageInfo{ hasNextPage endCursor }
        nodes{ nameWithOwner url isFork isArchived isPrivate pushedAt primaryLanguage{ name }
               defaultBranchRef{ target{ ... on Commit { history(first:0){ totalCount } } } } }
      }
    }
    ... on Organization {
      login databaseId name email location websiteUrl createdAt avatarUrl
      repositories(first:$n, after:$after, orderBy:{field:PUSHED_AT,direction:DESC}){
        totalCount pageInfo{ hasNextPage endCursor }
        nodes{ nameWithOwner url isFork isArchived isPrivate pushedAt primaryLanguage{ name }
               defaultBranchRef{ target{ ... on Commit { history(first:0){ totalCount } } } } }
      }
    }
  }
}`;

interface RepoNode {
    nameWithOwner: string;
    url: string;
    isFork: boolean;
    isArchived: boolean;
    pushedAt: string | null;
    primaryLanguage: { name: string } | null;
    defaultBranchRef: { target?: { history?: { totalCount?: number } } } | null;
}

const commitCount = (r: RepoNode): number => r.defaultBranchRef?.target?.history?.totalCount ?? 0;

export const accountRepos = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.github_account_repos',
        content_type: 'vineyard:plugin',
        name: 'GitHub Account Repositories',
        version: '1.0.0',
        description:
            'Expands a GitHub account (or a github.com profile URL) into its repositories, one URL node each, and enriches the account with the profile GitHub publishes — display name, company, location, website, and the numeric account id that survives a username change. Each repository node carries its commit count, so the cost of running Commit Identities on it is visible before you do. Optionally also finds repositories the account committed to but does not own.',
        icon: 'folder-git-2',
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
            produces: [
                { typepack: 'run.vineyard.typepacks.infrastructure', category: 'web', name: 'url' },
                { typepack: 'run.vineyard.typepacks.identity', category: 'identity', name: 'account' },
                { typepack: 'run.vineyard.typepacks.identity', category: 'identity', name: 'organization' },
            ],
        },
        params: {
            type: 'object',
            properties: {
                include_forks: {
                    type: 'boolean',
                    title: 'Include forked repositories',
                    default: false,
                    description:
                        'Forks are copies of somebody else’s project. Scanning one for commit identities returns the UPSTREAM contributors, who have nothing to do with this account.',
                },
                include_contributed: {
                    type: 'boolean',
                    title: 'Also find repositories they only contributed to',
                    default: true,
                    description:
                        'Uses commit search to find repositories the account committed to without owning — often where the work-account and organisation activity is. Commit search also indexes forked copies, so on very active accounts some results are mirrors rather than real contributions.',
                },
            },
        },
        scopes: {
            graph: ['node:read', 'node:create', 'node:update', 'edge:create'],
            network: [
                {
                    endpoint: 'https://api.github.com/graphql',
                    methods: ['POST'],
                    purpose: 'Read the public profile and repository list of the selected account.',
                },
                {
                    endpoint: 'https://api.github.com/search',
                    methods: ['GET'],
                    purpose: 'Find repositories the account committed to but does not own.',
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
        if (!ids.length) return { summary: 'Select a GitHub account, handle, or profile URL first', counts: {} };

        const includeForks = ctx.params?.include_forks === true;
        const includeContributed = ctx.params?.include_contributed !== false;

        let accounts = 0;
        let repos = 0;
        let contributed = 0;
        let orgs = 0;
        let skipped = 0;
        let reachedLogins = 0;

        // The host calls run() ONCE with the whole selection; walking it is this plugin's job.
        for (let i = 0; i < ids.length; i++) {
            if (abortIf(ctx)) {
                return {
                    summary: `Cancelled after ${i}/${ids.length} selected node(s) — ${repos} repositories added`,
                    counts: { accounts, repositories: repos, contributed, organizations: orgs, skipped },
                };
            }
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
            reachedLogins++;
            ctx.progress?.set?.({
                percent: Math.round((100 * i) / ids.length),
                message: `Reading ${login} (${i + 1}/${ids.length})`,
            });

            // ---- profile + owned repositories ------------------------------------------------
            let after: string | null = null;
            let owner: any = null;
            const collected: RepoNode[] = [];
            for (let page = 0; page < 10; page++) {
                const data = await gql(ctx, PROFILE_QUERY, { login, n: 100, after });
                owner = data?.repositoryOwner;
                if (!owner) break;
                const rs = owner.repositories;
                collected.push(...(rs?.nodes ?? []));
                if (!rs?.pageInfo?.hasNextPage) break;
                after = rs.pageInfo.endCursor;
                if (abortIf(ctx)) break;
            }
            if (!owner) {
                // A login that resolves to nothing is a fact worth stopping on, not a quiet zero.
                throw new Error(`GitHub has no user or organisation called "${login}"`);
            }

            const isOrg = owner.__typename === 'Organization';
            const accountId = String(seed.id);

            // Enrich the SELECTED node when it is already an account; otherwise create one so the
            // repositories have an owner to hang off.
            let anchorId = accountId;
            if (seed.type === 'identity.account') {
                // A DELTA — only the fields this plugin actually learned. Passing a full snapshot
                // would clobber whatever another pack wrote on the same node.
                await ctx.graph!.updateNode!(accountId, {
                    platform: GH_PLATFORM,
                    user_id: String(owner.databaseId ?? ''),
                    display_name: owner.name ?? undefined,
                    profile_url: `https://github.com/${owner.login}`,
                });
            } else {
                const node = await ctx.graph!.createNode!({
                    type: 'identity.account',
                    data: {
                        username: owner.login,
                        platform: GH_PLATFORM,
                        user_id: String(owner.databaseId ?? ''),
                        display_name: owner.name ?? undefined,
                        profile_url: `https://github.com/${owner.login}`,
                    },
                });
                accounts++;
                anchorId = String(node.id);
                if (anchorId !== accountId) {
                    await ctx.graph!.createEdge!({ from: accountId, to: anchorId, label: 'github account' });
                }
            }

            // ---- organisations ----------------------------------------------------------------
            for (const o of owner.organizations?.nodes ?? []) {
                if (!o?.login) continue;
                const orgNode = await ctx.graph!.createNode!({
                    type: 'identity.organization',
                    data: { name: o.name || o.login, website: `https://github.com/${o.login}` },
                });
                orgs++;
                await ctx.graph!.createEdge!({ from: anchorId, to: String(orgNode.id), label: 'member_of' });
            }

            // ---- repository nodes --------------------------------------------------------------
            for (const r of collected) {
                if (!r?.url) continue;
                if (r.isFork && !includeForks) continue;
                const node = await ctx.graph!.createNode!({
                    type: 'web.url',
                    data: {
                        url: r.url,
                        title: r.nameWithOwner,
                        // The number that decides whether Commit Identities is cheap or not.
                        commit_count: commitCount(r),
                        is_fork: r.isFork,
                        archived: r.isArchived,
                        pushed_at: r.pushedAt ?? undefined,
                        language: r.primaryLanguage?.name ?? undefined,
                    },
                });
                repos++;
                await ctx.graph!.createEdge!({
                    from: anchorId,
                    to: String(node.id),
                    label: isOrg ? 'organisation repository' : 'owns repository',
                });
            }

            // ---- repositories they contributed to but do not own ------------------------------
            if (includeContributed && !abortIf(ctx)) {
                const seen = new Set(collected.map((r) => r.nameWithOwner.toLowerCase()));
                const found = new Map<string, string>();
                const res = await rest(
                    ctx,
                    `/search/commits?q=${encodeURIComponent(`author:${login}`)}&per_page=100`,
                );
                for (const item of res?.items ?? []) {
                    const full = item?.repository?.full_name;
                    const html = item?.repository?.html_url;
                    if (!full || !html) continue;
                    if (full.toLowerCase().startsWith(`${login.toLowerCase()}/`)) continue;
                    if (seen.has(full.toLowerCase())) continue;
                    found.set(full, html);
                }
                for (const [full, html] of found) {
                    const node = await ctx.graph!.createNode!({
                        type: 'web.url',
                        data: { url: html, title: full },
                    });
                    contributed++;
                    await ctx.graph!.createEdge!({
                        from: anchorId,
                        to: String(node.id),
                        label: 'committed to this repository',
                    });
                }
            }
        }

        if (!reachedLogins) {
            // Every selected node was the wrong kind. Returning would render as a successful run
            // that found nothing, which is a different and misleading statement.
            throw new Error(
                `None of the ${ids.length} selected node(s) name a GitHub account — select an Account ` +
                    `with a GitHub platform, a Handle, or a https://github.com/<login> URL.`,
            );
        }

        return {
            summary:
                `${repos} repositor${repos === 1 ? 'y' : 'ies'} from ${reachedLogins} account(s)` +
                (contributed ? `, ${contributed} contributed-to` : '') +
                (orgs ? `, ${orgs} organisation(s)` : '') +
                (skipped ? ` — ${skipped} selected node(s) were not GitHub accounts` : ''),
            counts: { accounts, repositories: repos, contributed, organizations: orgs, skipped },
        };
    },
});
