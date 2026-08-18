// Repo Commit Identities — recovers the people behind a repository from its commit metadata.
//
// WHAT IT READS AND WHY THAT SHAPE:
//
// Commit metadata only — never a commit's own endpoint. The history connection returns author
// name/email/linked-account per commit and nothing else; asking for an individual commit would
// return `files[].patch`, i.e. the source diff, for data already in hand.
//
// GraphQL rather than REST /commits. Same underlying records, but naming the four fields costs
// ~190 bytes per commit against REST's ~4.6 KB, and several refs fit in ONE request as aliases, so
// a repository that is 119 REST pages is single-digit requests here. Verified against a
// `--filter=blob:none` bare clone of six repositories: identical author-email sets.
//
// All refs, not just the default branch. `/commits` and the default-branch history both stop at
// HEAD; contributors whose only commits sit on a side branch or behind a tag are invisible there.
//
// THREE MEASURED TRAPS THIS AVOIDS:
//
//  1. Filtering on the linked login drops the best addresses. A commit whose email belongs to no
//     GitHub account has `author.user == null` — that is the raw local .gitconfig value, the kind
//     that leaks a machine hostname. On one repository 9 of 35 commits were exactly this.
//  2. `committer` is not the author. On a sample of 100 commits from a busy repository, 52 carried
//     the shared web-flow address noreply@github.com — one string every GitHub user merging through
//     the web UI writes. As a node it is a permanent cross-case hub. Only `author` is read.
//  3. `?author=<login>` silently under-returns. Measured 36 of 52 commits across one account's
//     repositories; the missing 16 were all commits made under a PREVIOUS username's noreply
//     address. Not used anywhere.
import { definePlugin } from './sdk';
import type { HostContext, RunResult, GraphNode } from './sdk';
import { ghToken, GH_PLATFORM, gql, repoOf, classifyEmail, domainOf, abortIf } from './gh';

/** Above this the walk is long enough that the analyst should narrow it deliberately rather than
 *  discover the cost by waiting. The Linux kernel is ~1.4M commits: ~700 requests. */
const MAX_COMMITS = 100_000;

/** Repositories in one run when NONE of them carries a commit count — the only case where the cost
 *  cannot be summed in advance. Above this the run is refused rather than started blind. */
const MAX_REPOS_PER_RUN = 20;

/** Refs per request. Each is its own `history` connection of 100. */
const REFS_PER_QUERY = 15;

/** Safety rail on the per-ref walk. Reached only by a branch with a very long unique history. */
const MAX_PAGES_PER_REF = 200;

const REFS_QUERY = `query($owner:String!,$name:String!,$after:String){
  repository(owner:$owner,name:$name){
    isEmpty
    defaultBranchRef{ name target{ ... on Commit { history(first:0){ totalCount } } } }
    refs(refPrefix:"refs/",first:100,after:$after){
      totalCount pageInfo{ hasNextPage endCursor } nodes{ name }
    }
  }
}`;

interface CommitRow {
    oid: string;
    email: string;
    name: string;
    login: string | null;
    date: string | null;
}

/** Build one query that walks up to REFS_PER_QUERY refs a page each. */
function historyQuery(count: number): string {
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
        parts.push(
            `  r${i}: ref(qualifiedName:$q${i}){ target{ ... on Commit {` +
                ` history(first:100, after:$a${i}){ pageInfo{ hasNextPage endCursor }` +
                ` nodes{ oid committedDate author{ email name user{ login } } } } } } }`,
        );
    }
    const args = Array.from({ length: count }, (_, i) => `$q${i}:String!,$a${i}:String`).join(',');
    return `query($owner:String!,$name:String!,${args}){\n  repository(owner:$owner,name:$name){\n${parts.join('\n')}\n  }\n}`;
}

export const commitIdentities = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.github_commit_identities',
        content_type: 'vineyard:plugin',
        name: 'GitHub Commit Identities',
        version: '1.3.0',
        description:
            'Reads the commit metadata of every branch and tag of the selected repositories — never the code — and recovers the identities in it: the email address each contributor committed under, their display name, their GitHub account, and any previous username still embedded in an older relay address. Addresses that belong to no GitHub account are kept rather than dropped: those are the raw local git configurations, and they are usually the ones worth having. Enabling email privacy on GitHub does not rewrite history, so a repository that predates it still carries the real address.',
        icon: 'git-commit-horizontal',
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
                { typepack: 'run.vineyard.typepacks.identity', category: 'identity', name: 'account' },
                { typepack: 'run.vineyard.typepacks.identity', category: 'identity', name: 'email_address' },
                { typepack: 'run.vineyard.typepacks.identity', category: 'identity', name: 'handle' },
            ],
        },
        params: {
            type: 'object',
            properties: {
                all_refs: {
                    type: 'boolean',
                    title: 'Scan every branch and tag',
                    default: true,
                    description:
                        'Off scans only the default branch, which is what the REST commit list would give you. On a large public repository the difference measured ~1,000 extra commits and a handful of contributors who appear nowhere else.',
                },
            },
        },
        scopes: {
            graph: ['node:read', 'node:create', 'node:update', 'edge:create'],
            network: [
                {
                    endpoint: 'https://api.github.com/graphql',
                    methods: ['POST'],
                    purpose: 'Read commit metadata (author, email, date) for the selected repositories.',
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
        const allRefs = ctx.params?.all_refs !== false;

        let accounts = 0;
        let emails = 0;
        let handles = 0;
        let scannedRepos = 0;   // repositories GitHub answered for — processed, whatever they held
        let emptyRepos = 0;     // of those, ones with no refs at all: a real answer, not a failure
        let goneRepos = 0;      // selected URLs GitHub says are not repositories (deleted/renamed)
        let scannedCommits = 0;
        let truncatedRefs = 0;

        // ---- resolve the selection BEFORE opening a single request -------------------------------
        //
        // The host hands this plugin whatever was selected — it does not filter by the declared
        // `consumes`, and neither does the agent — so a run started from "select everything" arrives
        // holding emails, handles, gists and unrelated URLs alongside the repositories. Two things
        // follow, and both have to happen here rather than inside the loop:
        //
        //   · Non-repositories are dropped without a request. `repoOf` is strict about the host for
        //     this reason: `gist.github.com/<user>/<id>` used to parse as owner/repo, and the Gists
        //     plugin in this very pack produces those nodes by the dozen.
        //   · The total cost is known and refused UP FRONT when it cannot finish. Account
        //     Repositories writes `commit_count` on every repository node it creates precisely so
        //     this sum exists; a whole-project run over fifty repositories is otherwise an hour of
        //     silent work whose only visible outcome is that it eventually stopped.
        const targetsToScan: { id: string; repo: { owner: string; name: string; url: string }; cost: number | null }[] = [];
        let skipped = 0;
        for (const id of ids) {
            const seed = await ctx.graph!.get!(id);
            const repo = seed ? repoOf(seed) : null;
            if (!seed || !repo) {
                skipped++;
                continue;
            }
            const c = Number((seed.data as any)?.commit_count);
            targetsToScan.push({ id: String(seed.id), repo, cost: Number.isFinite(c) && c >= 0 ? c : null });
        }

        const known = targetsToScan.reduce((n, t) => n + (t.cost ?? 0), 0);
        const unknown = targetsToScan.filter((t) => t.cost === null).length;
        if (known > MAX_COMMITS) {
            throw new Error(
                `The ${targetsToScan.length} selected repositories hold ${known.toLocaleString()} commits between ` +
                    `them — more than this plugin will walk in one run (${MAX_COMMITS.toLocaleString()}). Select fewer, ` +
                    `or start with the ones whose commit_count is largest.`,
            );
        }
        if (targetsToScan.length > MAX_REPOS_PER_RUN && unknown === targetsToScan.length) {
            // No cost is known for any of them, so the sum above proved nothing. Fall back to a
            // count, and say that is what happened rather than pretending to have measured.
            throw new Error(
                `${targetsToScan.length} repositories selected and none carries a commit count, so the size of ` +
                    `this run cannot be established before it starts. Run GitHub Account Repositories first ` +
                    `(it records the count), or select at most ${MAX_REPOS_PER_RUN} at a time.`,
            );
        }

        for (let i = 0; i < targetsToScan.length; i++) {
            if (abortIf(ctx)) break;
            const { id: seedId, repo } = targetsToScan[i];
            const seed = await ctx.graph!.get!(seedId);
            if (!seed) continue;

            ctx.progress?.set?.({
                percent: Math.round((100 * i) / targetsToScan.length),
                message: `${repo.owner}/${repo.name} (${i + 1}/${targetsToScan.length})`,
            });

            // ---- refs and size ---------------------------------------------------------------
            let missing = false;
            const refNames: string[] = [];
            let defaultRef: string | null = null;
            let totalCommits = 0;
            let after: string | null = null;
            for (let page = 0; page < 10; page++) {
                const d = await gql(ctx, REFS_QUERY, { owner: repo.owner, name: repo.name, after });
                const r = d?.repository;
                // Answered with "no such repository": processed, empty. One dead URL in a large
                // selection must not discard everything collected before it.
                if (!r) { missing = true; break; }
                if (r.isEmpty) break;
                if (page === 0) {
                    defaultRef = r.defaultBranchRef?.name ? `refs/heads/${r.defaultBranchRef.name}` : null;
                    totalCommits = r.defaultBranchRef?.target?.history?.totalCount ?? 0;
                    // Refuse loudly instead of walking for an hour or capping in silence.
                    if (totalCommits > MAX_COMMITS) {
                        throw new Error(
                            `${repo.owner}/${repo.name} has ${totalCommits.toLocaleString()} commits on its default ` +
                                `branch — more than this plugin will walk in one run (${MAX_COMMITS.toLocaleString()}). ` +
                                `Pick a smaller repository, or scan this one outside Vineyard.`,
                        );
                    }
                }
                for (const n of r.refs?.nodes ?? []) if (n?.name) refNames.push(`refs/${n.name}`);
                if (!r.refs?.pageInfo?.hasNextPage) break;
                after = r.refs.pageInfo.endCursor;
            }

            if (missing) {
                goneRepos++;
                continue;
            }

            // The repository answered, so it HAS been processed — count it before the walk, not
            // after. Counting only repositories that yielded commits made an empty repository
            // indistinguishable from a mis-targeted selection: pick three empty ones and the run
            // ended with "none of the selected nodes is a GitHub repository URL", which was both
            // wrong and unfixable by the analyst.
            scannedRepos++;

            // Default branch first: it holds the bulk, so every later ref mostly re-walks known
            // commits and stops almost immediately.
            let targets = allRefs ? refNames : defaultRef ? [defaultRef] : [];
            if (defaultRef) targets = [defaultRef, ...targets.filter((n) => n !== defaultRef)];
            if (!targets.length) {
                emptyRepos++;
                continue; // an empty repository: a real, finished answer with nothing in it
            }

            // ---- walk ------------------------------------------------------------------------
            const seenOids = new Set<string>();
            const rows: CommitRow[] = [];
            for (let start = 0; start < targets.length; start += REFS_PER_QUERY) {
                if (abortIf(ctx)) break;
                const batch = targets.slice(start, start + REFS_PER_QUERY);
                const query = historyQuery(batch.length);
                const cursors: (string | null)[] = batch.map(() => null);
                const done: boolean[] = batch.map(() => false);

                for (let page = 0; page < MAX_PAGES_PER_REF; page++) {
                    if (abortIf(ctx)) break;
                    if (done.every(Boolean)) break;
                    const vars: Record<string, unknown> = { owner: repo.owner, name: repo.name };
                    batch.forEach((q, k) => {
                        vars[`q${k}`] = q;
                        vars[`a${k}`] = done[k] ? null : cursors[k];
                    });
                    const d = await gql(ctx, query, vars);
                    const repoData = d?.repository ?? {};
                    let anyProgress = false;

                    batch.forEach((_q, k) => {
                        if (done[k]) return;
                        const h = repoData[`r${k}`]?.target?.history;
                        if (!h) {
                            done[k] = true;
                            return;
                        }
                        let fresh = 0;
                        for (const c of h.nodes ?? []) {
                            if (!c?.oid || seenOids.has(c.oid)) continue;
                            seenOids.add(c.oid);
                            fresh++;
                            const a = c.author ?? {};
                            rows.push({
                                oid: c.oid,
                                email: String(a.email ?? ''),
                                name: String(a.name ?? ''),
                                login: a.user?.login ? String(a.user.login) : null,
                                date: c.committedDate ?? null,
                            });
                        }
                        // A page that added nothing means this ref has merged back into history we
                        // already hold — every remaining page is ancestors we have. Stop.
                        if (fresh === 0) {
                            done[k] = true;
                            return;
                        }
                        anyProgress = true;
                        if (h.pageInfo?.hasNextPage) cursors[k] = h.pageInfo.endCursor;
                        else done[k] = true;
                    });

                    if (!anyProgress) break;
                    if (page === MAX_PAGES_PER_REF - 1 && !done.every(Boolean)) truncatedRefs++;
                }
            }

            scannedCommits += rows.length;

            // ---- who is a bot ----------------------------------------------------------------
            // GitHub's own marker only: an App commits under a login ending in "[bot]".
            //
            // This started as "any address above 25% of the repository's commits", which is exactly
            // the wrong shape and the test caught it on the first real repository: in a project with
            // one author, that author IS every commit, so the rule deleted the very addresses the
            // plugin exists to find — a real mailbox and an unlinked local git identity both
            // vanished as "bots". A share threshold cannot tell a robot from a sole maintainer,
            // because the thing it measures is the same in both.
            //
            // A project's own automation account (a plain user account a maintainer scripts) stays.
            // That is deliberate: it is a true account, it really did author those commits, and
            // dropping it would hide a real actor to save the reader an obvious node.
            const isBot = (login: string | null): boolean => !!login && /\[bot\]$/i.test(login);

            // ---- fold rows into identities ----------------------------------------------------
            interface Person {
                login: string | null;
                names: Set<string>;
                emails: Set<string>;
                userId: string | null;
                formerLogins: Set<string>;
            }
            const byLogin = new Map<string, Person>();
            const orphanEmails = new Map<string, Set<string>>(); // email -> display names

            for (const r of rows) {
                if (isBot(r.login)) continue;
                const cls = classifyEmail(r.email);
                if (r.login) {
                    let p = byLogin.get(r.login);
                    if (!p) {
                        p = { login: r.login, names: new Set(), emails: new Set(), userId: null, formerLogins: new Set() };
                        byLogin.set(r.login, p);
                    }
                    if (r.name) p.names.add(r.name);
                    if (cls.email) p.emails.add(cls.email);
                    if (cls.userId) p.userId = cls.userId;
                    // A relay address spelling a DIFFERENT login is a former username: the numeric
                    // id is stable across a rename, the embedded name is not.
                    if (cls.noreplyLogin && cls.noreplyLogin.toLowerCase() !== r.login.toLowerCase()) {
                        p.formerLogins.add(cls.noreplyLogin);
                    }
                } else if (cls.email) {
                    const set = orphanEmails.get(cls.email) ?? new Set<string>();
                    if (r.name) set.add(r.name);
                    orphanEmails.set(cls.email, set);
                }
            }

            // ---- write ------------------------------------------------------------------------
            const repoNodeId = String(seed.id);
            for (const p of byLogin.values()) {
                const acct = await ctx.graph!.createNode!({
                    type: 'identity.account',
                    data: {
                        username: p.login,
                        platform: GH_PLATFORM,
                        user_id: p.userId ?? undefined,
                        display_name: [...p.names][0],
                        profile_url: `https://github.com/${p.login}`,
                    },
                });
                accounts++;
                await ctx.graph!.createEdge!({
                    from: String(acct.id),
                    to: repoNodeId,
                    label: 'authored commits in this repository',
                });

                for (const e of p.emails) {
                    const em = await ctx.graph!.createNode!({
                        type: 'identity.email_address',
                        data: { email: e, domain: domainOf(e), display_name: [...p.names][0] },
                    });
                    emails++;
                    // GitHub only attaches a login to a commit when the address is a VERIFIED email
                    // on that account, so this edge records GitHub's own registration record — not
                    // an inference drawn from the free-text git field.
                    await ctx.graph!.createEdge!({
                        from: String(acct.id),
                        to: String(em.id),
                        label: 'registered email on this account (GitHub-linked commit)',
                    });
                }

                for (const former of p.formerLogins) {
                    const h = await ctx.graph!.createNode!({
                        type: 'identity.handle',
                        data: {
                            handle: former,
                            first_seen_context: `Former GitHub username, recovered from a commit relay address in ${repo.owner}/${repo.name}.`,
                        },
                    });
                    handles++;
                    await ctx.graph!.createEdge!({
                        from: String(h.id),
                        to: String(acct.id),
                        label: 'resolves_to',
                    });
                }
            }

            for (const [e, names] of orphanEmails) {
                const em = await ctx.graph!.createNode!({
                    type: 'identity.email_address',
                    data: { email: e, domain: domainOf(e), display_name: [...names][0] },
                });
                emails++;
                // No linked account: GitHub does not know this address, so the only thing proven is
                // that somebody committed under it here.
                await ctx.graph!.createEdge!({
                    from: String(em.id),
                    to: repoNodeId,
                    label: 'authored commits in this repository (address not registered to any GitHub account)',
                });
            }

            // Record the scan on the repository itself, so a later reader can see what was covered
            // without re-running it. A delta — nothing else on the node is touched.
            await ctx.graph!.updateNode!(repoNodeId, {
                commits_scanned: rows.length,
                refs_scanned: targets.length,
                commit_scan_scope: allRefs ? 'all branches and tags' : 'default branch only',
            });
        }

        // THROW ONLY WHEN THE REQUEST COULD NOT BE PROCESSED — nothing selected was a repository.
        // A repository that answered and held nothing is a finished answer and returns normally.
        if (!scannedRepos && !goneRepos) {
            throw new Error(
                `None of the ${ids.length} selected node(s) is a GitHub repository URL — select nodes ` +
                    `whose url looks like https://github.com/<owner>/<repo>.`,
            );
        }

        return {
            summary:
                `${scannedCommits.toLocaleString()} commits across ${scannedRepos} repositor${scannedRepos === 1 ? 'y' : 'ies'}: ` +
                `${accounts} account(s), ${emails} email address(es)` +
                (emptyRepos ? `, ${emptyRepos} repositor${emptyRepos === 1 ? 'y was' : 'ies were'} empty` : '') +
                (goneRepos ? `, ${goneRepos} no longer exist on GitHub` : '') +
                (handles ? `, ${handles} former username(s)` : '') +
                (truncatedRefs ? ` — ${truncatedRefs} ref(s) hit the page limit` : '') +
                (skipped ? ` — ${skipped} selected node(s) were not repositories` : ''),
            counts: {
                repositories: scannedRepos,
                commits: scannedCommits,
                accounts,
                emails,
                former_usernames: handles,
                empty_repositories: emptyRepos,
                gone_repositories: goneRepos,
                skipped,
            },
        };
    },
});
