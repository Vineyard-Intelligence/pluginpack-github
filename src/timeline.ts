// Activity Timeline — when, in UTC, an account's public events happen.
//
// CREATES NO NODES. The observation belongs on the account it describes, written as a delta.
// The obvious alternative, a geo.location node holding a timezone, is wrong twice: the node's
// identity is its name, so one "UTC+9" would merge every Korean, Japanese and eastern-Russian
// subject in the graph onto a single entity — and an hour histogram is not a location claim in the
// first place.
//
// AND IT HARVESTS NO EMAILS, though the payloads contain them. A PushEvent fires under the account
// that PUSHED; each commit inside carries its own author block. On a busy repository author and
// committer diverged on 52 of 100 measured commits. Reading those addresses as the pusher's own
// would give any maintainer who merges pull requests the personal address of everyone whose work
// they merged. Commit Identities collects emails, under its own rules.
//
// The sample is bounded by GitHub, not by this plugin: roughly 300 events over at most 90 days. So
// the window is a function of how active the account is — a heavy account's 300 events may span a
// week, a quiet one's the full 90 days — and both would otherwise land on the node looking equally
// authoritative. The event count and the real first/last timestamps are written alongside for that
// reason.
import { definePlugin } from './sdk';
import type { HostContext, RunResult } from './sdk';
import { ghToken, GH_PLATFORM, rest, loginOf, abortIf } from './gh';

export const activityTimeline = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.github_activity_timeline',
        content_type: 'vineyard:plugin',
        name: 'GitHub Activity Timeline',
        version: '1.1.0',
        description:
            'Reads an account\'s recent public events and records which UTC hours it is active in, as fields on the account itself rather than as new nodes. Also records how many events the sample held and the real first and last timestamps, because GitHub caps this feed at roughly 300 events over 90 days — so a busy account\'s picture may cover a week and a quiet one\'s three months. Automation produces the tightest, most convincing-looking distributions of all, so read a sharp result as a scheduler until something else says otherwise.',
        icon: 'clock',
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
            produces: [{ typepack: 'run.vineyard.typepacks.identity', category: 'identity', name: 'account' }],
        },
        scopes: {
            graph: ['node:read', 'node:create', 'node:update', 'edge:create'],
            network: [
                {
                    endpoint: 'https://api.github.com/users',
                    methods: ['GET'],
                    purpose: 'Read the public event feed of the selected account.',
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
        // Token first, before anything about the selection is judged. It is a precondition of the
        // whole run rather than of one node, and when both are wrong "this pack has no token" is the
        // message that lets the analyst act — checking the selection first made the reported problem
        // depend on which node happened to be selected.
        ghToken(ctx);

        let profiled = 0;   // accounts that had events, so a histogram was written
        let quiet = 0;      // accounts read successfully that published nothing in the window
        let reached = 0;    // selected nodes that actually named a GitHub account
        let skipped = 0;    // selected nodes that named none — the only kind that is a mis-target
        let totalEvents = 0;

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

            const stamps: string[] = [];
            const kinds = new Map<string, number>();
            // Three pages is the whole feed: GitHub stops at ~300 events regardless.
            for (let page = 1; page <= 3; page++) {
                const rows = await rest(ctx, `/users/${encodeURIComponent(login)}/events/public?per_page=100&page=${page}`);
                if (!Array.isArray(rows) || !rows.length) break;
                for (const e of rows) {
                    if (typeof e?.created_at === 'string') stamps.push(e.created_at);
                    if (typeof e?.type === 'string') kinds.set(e.type, (kinds.get(e.type) ?? 0) + 1);
                }
                if (rows.length < 100) break;
            }

            if (!stamps.length) {
                // A real answer, not a failure: this account published nothing in the window GitHub
                // keeps. Counted separately from `skipped`, which is for nodes that never named an
                // account at all — the two must not be added together, because only the second one
                // means the run could not do its job.
                quiet++;
                continue;
            }

            const hours = new Array<number>(24).fill(0);
            for (const s of stamps) {
                const d = new Date(s);
                if (!Number.isNaN(d.getTime())) hours[d.getUTCHours()]++;
            }
            const sorted = [...stamps].sort();

            // Anchor on an account node: enrich the seed when it already is one, otherwise make it.
            let target = String(seed.id);
            if (seed.type !== 'identity.account') {
                const acct = await ctx.graph!.createNode!({
                    type: 'identity.account',
                    data: { username: login, platform: GH_PLATFORM, profile_url: `https://github.com/${login}` },
                });
                target = String(acct.id);
                if (target !== String(seed.id)) {
                    await ctx.graph!.createEdge!({ from: String(seed.id), to: target, label: 'github account' });
                }
            }

            await ctx.graph!.updateNode!(target, {
                activity_hours_utc: hours.join(','),
                events_sampled: stamps.length,
                activity_window_start: sorted[0],
                activity_window_end: sorted[sorted.length - 1],
                event_types: [...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(' '),
            });
            profiled++;
            totalEvents += stamps.length;
        }

        // THROW ONLY WHEN THE REQUEST COULD NOT BE PROCESSED — i.e. nothing selected named a GitHub
        // account. An account that simply has no public activity is a finished, correct answer, and
        // reporting it as a failure would be a false negative dressed as an error.
        if (!reached) {
            throw new Error(
                `None of the ${ids.length} selected node(s) names a GitHub account — select an Account ` +
                    `with a GitHub platform, a Handle, or a https://github.com/<login> URL.`,
            );
        }

        return {
            summary:
                (profiled
                    ? `${profiled} account(s) profiled from ${totalEvents} public event(s)`
                    : `no public activity in GitHub's ~90-day window for ${quiet} account(s) — read, and empty`) +
                (profiled && quiet ? `; ${quiet} had no public activity` : '') +
                (skipped ? ` — ${skipped} selected node(s) were not GitHub accounts` : ''),
            counts: { accounts: profiled, quiet, events: totalEvents, skipped },
        };
    },
});
