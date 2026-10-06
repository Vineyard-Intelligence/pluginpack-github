#!/usr/bin/env node
/**
 * Run the built pack against the live GitHub API with an in-memory graph.
 *
 * Not a unit test — the point is that the plugins are exercised end to end against the real API
 * surface they were written for, because every failure mode this pack guards against (a token that
 * is refused, a login the filter drops, a relay address mistaken for a mailbox) is a property of
 * the real responses and disappears the moment they are mocked.
 *
 *   GITHUB_TOKEN=<token> node test-plugin.mjs [owner]
 *   node test-plugin.mjs            # no token: only the steps whose network is stubbed
 *
 * The host contract this stands in for, and which the assertions below check:
 *   · run() is called ONCE with the whole selection; the plugin walks it.
 *   · updateNode receives a DELTA, so it must merge, never replace.
 *   · a thrown error is the only failure the host sees — a plain return always reads as success.
 */
import assert from 'node:assert/strict';

const TOKEN = process.env.GITHUB_TOKEN;
// Without a token the live steps are skipped. The stand-in below only satisfies the plugins' token
// check: every step that still runs either stubs `net.fetch` or is refused before any request.
const LIVE = !!TOKEN;
if (!LIVE) console.warn('GITHUB_TOKEN is not set — running only the steps with a stubbed network');
const OWNER = process.argv[2] ?? 'whatabeautifulmemory';

const pack = (await import('./dist/pack.mjs')).default;
const byId = Object.fromEntries(pack.plugins.map((p) => [p.manifest.identifier.split('.').pop(), p]));

// ---- in-memory graph -------------------------------------------------------------------------
function makeGraph() {
    const nodes = new Map();
    const edges = [];
    let seq = 0;
    /** Identity mirrors the real host: (username, platform) for accounts, else the label field. */
    const keyOf = (type, data) => {
        if (type === 'identity.account') {
            return `${type}|${String(data.username ?? '').toLowerCase()}|${String(data.platform ?? '').toLowerCase()}`;
        }
        const label = { 'identity.email_address': 'email', 'identity.handle': 'handle', 'web.url': 'url', 'infrastructure.domain': 'domain_name', 'identity.organization': 'name', 'identity.pgp_key': 'fingerprint' }[type];
        return `${type}|${String(data[label] ?? '').toLowerCase()}`;
    };
    return {
        nodes,
        edges,
        async get(id) {
            return nodes.get(String(id)) ?? null;
        },
        async createNode(draft) {
            const k = keyOf(draft.type, draft.data);
            for (const n of nodes.values()) {
                if (n._k === k) {
                    // Merge, the way the host de-dups on identity.
                    for (const [f, v] of Object.entries(draft.data)) if (v !== undefined) n.data[f] = v;
                    return n;
                }
            }
            const id = `n${++seq}`;
            const node = { id, type: draft.type, data: { ...draft.data }, _k: k };
            nodes.set(id, node);
            return node;
        },
        async updateNode(id, data) {
            const n = nodes.get(String(id));
            if (!n) throw new Error(`updateNode on missing node ${id}`);
            // A DELTA: fields not named must survive. This is the contract the pack relies on.
            for (const [f, v] of Object.entries(data)) if (v !== undefined) n.data[f] = v;
        },
        async createEdge(e) {
            edges.push({ from: String(e.from), to: String(e.to), label: e.label });
        },
    };
}

function makeCtx(graph, selection, params = {}) {
    return {
        run: { runId: 'test', projectId: 'test' },
        input: { selection },
        params,
        config: { token: TOKEN ?? 'offline-stand-in' },
        graph,
        net: {
            fetch: async (url, init) => {
                const res = await fetch(url, init);
                const body = await res.text();
                const headers = {};
                res.headers.forEach((v, k) => (headers[k] = v));
                return { ok: res.ok, status: res.status, headers, text: async () => body };
            },
        },
        progress: { set: () => {} },
        signal: { aborted: false },
    };
}

const show = (r) => `      → ${r?.summary ?? '(no summary)'}`;
let failures = 0;
async function step(name, fn, live = false) {
    if (live && !LIVE) {
        process.stdout.write(`\n- ${name} (skipped: needs GITHUB_TOKEN)\n`);
        return;
    }
    process.stdout.write(`\n▶ ${name}\n`);
    try {
        await fn();
    } catch (e) {
        failures++;
        console.error(`  ✗ ${e.message}`);
    }
}

// ---- 1. a missing token must THROW, not return an empty result ---------------------------------
await step('token absent → throws (an empty return would read as "nothing found")', async () => {
    const g = makeGraph();
    const seed = await g.createNode({ type: 'identity.account', data: { username: OWNER, platform: 'GitHub (User)' } });
    const ctx = makeCtx(g, [seed.id]);
    ctx.config = {};
    await assert.rejects(() => byId.github_account_repos.run(ctx), /token is not set/i);
    console.log('  ✓ throws with an actionable message');
});

// ---- 2. account → repositories ------------------------------------------------------------------
const g = makeGraph();
let repoNodes = [];
await step('Account Repositories', async () => {
    const seed = await g.createNode({
        type: 'identity.account',
        data: { username: OWNER, platform: 'GitHub (User)', note: 'pre-existing field' },
    });
    const res = await byId.github_account_repos.run(makeCtx(g, [seed.id], { include_forks: false, include_contributed: true }));
    console.log(show(res));
    repoNodes = [...g.nodes.values()].filter((n) => n.type === 'web.url');
    assert.ok(repoNodes.length > 0, 'no repository nodes were produced');
    // The delta contract: enrichment must not wipe a field another pack wrote.
    assert.equal(seed.data.note, 'pre-existing field', 'updateNode clobbered an unrelated field');
    assert.ok(seed.data.user_id, 'the account was not enriched with its numeric id');
    // The cost signal the analyst needs before running the commit walk.
    assert.ok(repoNodes.some((n) => typeof n.data.commit_count === 'number'), 'no commit_count on repositories');
    console.log(`  ✓ ${repoNodes.length} repositories, account enriched (user_id=${seed.data.user_id}), delta preserved`);
}, true);

// ---- 3. the whole selection is walked, not just the first ---------------------------------------
await step('Commit Identities over a MULTI-node selection', async () => {
    const g2 = makeGraph();
    const a = await g2.createNode({ type: 'web.url', data: { url: `https://github.com/${OWNER}/glossy` } });
    const b = await g2.createNode({ type: 'web.url', data: { url: `https://github.com/${OWNER}/sheet2yar` } });
    const res = await byId.github_commit_identities.run(makeCtx(g2, [a.id, b.id]));
    console.log(show(res));
    assert.equal(res.counts.repositories, 2, 'the plugin stopped after the first selected node');

    const emails = [...g2.nodes.values()].filter((n) => n.type === 'identity.email_address').map((n) => n.data.email);
    const handles = [...g2.nodes.values()].filter((n) => n.type === 'identity.handle').map((n) => n.data.handle);
    const accounts = [...g2.nodes.values()].filter((n) => n.type === 'identity.account');

    console.log(`      emails:  ${emails.join(', ') || '(none)'}`);
    console.log(`      handles: ${handles.join(', ') || '(none)'}`);

    // A relay address is not a mailbox: it must never become an email node.
    for (const e of emails) {
        assert.ok(!/users\.noreply\.github\.com$/i.test(e), `relay address leaked into a node: ${e}`);
        assert.ok(e !== 'you@example.com', 'git\'s unconfigured default became a node');
        assert.ok(e !== 'noreply@github.com', 'the shared web-flow committer address became a node');
    }
    // …but the account id inside it is worth keeping.
    assert.ok(accounts.some((a) => a.data.user_id), 'no account recovered its numeric id from a relay address');
    // A former username, if one is embedded, is a handle that resolves to the account.
    if (handles.length) {
        const e = g2.edges.find((x) => x.label === 'resolves_to');
        assert.ok(e, 'a former username was found but not linked to the account');
        console.log('  ✓ former username linked with resolves_to');
    }
    console.log('  ✓ relay/placeholder addresses excluded, numeric id kept');
}, true);

// ---- 4. an address belonging to no GitHub account must still be captured ------------------------
await step('Commit Identities keeps unlinked addresses (the login filter bug)', async () => {
    const g3 = makeGraph();
    const r = await g3.createNode({ type: 'web.url', data: { url: `https://github.com/${OWNER}/vineyard-website` } });
    const res = await byId.github_commit_identities.run(makeCtx(g3, [r.id]));
    console.log(show(res));
    const emails = [...g3.nodes.values()].filter((n) => n.type === 'identity.email_address').map((n) => n.data.email);
    console.log(`      emails: ${emails.join(', ') || '(none)'}`);
    // These commits have author.user === null; filtering on the linked login would drop them.
    assert.ok(emails.length > 0, 'an address with no linked GitHub account was dropped');
    const orphanEdge = g3.edges.find((e) => e.label.includes('not registered to any GitHub account'));
    assert.ok(orphanEdge, 'the unlinked address was not labelled as unlinked');
    console.log('  ✓ unlinked address captured and labelled honestly');
}, true);

// ---- 5. the rest, smoke-tested against the live API ---------------------------------------------
await step('Gists / Activity Timeline / Forks / Pages / Org members', async () => {
    const acct = [...g.nodes.values()].find((n) => n.type === 'identity.account');
    const repo = repoNodes[0];

    const gg = makeGraph();
    const s1 = await gg.createNode({ type: 'identity.account', data: { username: OWNER, platform: 'GitHub (User)' } });
    console.log(show(await byId.github_gists.run(makeCtx(gg, [s1.id]))));
    for (const n of gg.nodes.values()) {
        assert.notEqual(n.type, 'endpoint.file', 'a gist file name became a node — that type collapses on generic names');
    }

    const gt = makeGraph();
    const s2 = await gt.createNode({ type: 'identity.account', data: { username: OWNER, platform: 'GitHub (User)' } });
    const before = gt.nodes.size;
    console.log(show(await byId.github_activity_timeline.run(makeCtx(gt, [s2.id]))));
    assert.equal(gt.nodes.size, before, 'the timeline created nodes; it must only write fields on the account');
    assert.ok(s2.data.activity_hours_utc, 'no activity histogram was written');
    assert.ok(s2.data.events_sampled, 'the sample size was not recorded');

    const gf = makeGraph();
    const s3 = await gf.createNode({ type: 'web.url', data: { url: 'https://github.com/jekyll/jekyll' } });
    console.log(show(await byId.github_forks.run(makeCtx(gf, [s3.id], { max_forks: 100 }))));

    const gp = makeGraph();
    const s4 = await gp.createNode({ type: 'web.url', data: { url: `https://github.com/${OWNER}/vineyard-website` } });
    console.log(show(await byId.github_pages_domain.run(makeCtx(gp, [s4.id]))));

    const go = makeGraph();
    const s5 = await go.createNode({ type: 'identity.organization', data: { name: 'Vineyard-Intelligence', website: 'https://github.com/Vineyard-Intelligence' } });
    console.log(show(await byId.github_org_members.run(makeCtx(go, [s5.id]))));
    console.log('  ✓ all five ran against the live API');
}, true);

// ---- 6. a selection with nothing usable in it must throw ----------------------------------------
await step('wrong node type → throws rather than reporting an empty success', async () => {
    const gx = makeGraph();
    const junk = await gx.createNode({ type: 'identity.email_address', data: { email: 'nobody@example.com' } });
    await assert.rejects(() => byId.github_commit_identities.run(makeCtx(gx, [junk.id])), /is a GitHub repository URL/i);
    console.log('  ✓ throws');
});


// ---- 7. code search ----------------------------------------------------------------------------
// NOTE ON WHAT THIS CAN AND CANNOT SHOW. Node's fetch has no same-origin policy, so this exercises
// the plugin's logic and the API contract but NOT the CORS behaviour that makes it desktop-only:
// in a browser the same call is rejected before a status is visible. That part is verified by
// reading the shell (renderer publishes declared network origins -> main process strips Origin and
// injects the CORS headers) plus the measurement that GitHub omits the header only on authenticated
// code search. It has not been run inside the packaged desktop app.
await step('Code Search (whole-graph, no selection)', async () => {
    const gs = makeGraph();
    const ctx = makeCtx(gs, [], { query: `"BEGIN RSA PRIVATE KEY" user:${OWNER}`, max_results: 20 });
    const res = await byId.github_code_search.run(ctx);
    console.log(show(res));

    // A whole-graph plugin must not depend on a selection.
    assert.equal(ctx.input.selection.length, 0, 'the test passed a selection');
    // The query itself must never become a node — it would be a hub linked to every match.
    for (const n of gs.nodes.values()) {
        assert.notEqual(n.type, 'endpoint.file', 'a match path became a file node');
        assert.notEqual(String(n.data.url ?? ''), ctx.params.query, 'the query became a node');
    }
    // An honest zero is a RETURN (the search ran), not a throw.
    assert.ok(typeof res.counts.total_reported === 'number', 'the reported total was not recorded');

    // A broad query must say that it was capped rather than let the graph imply completeness.
    const wide = await byId.github_code_search.run(
        makeCtx(makeGraph(), [], { query: '"BEGIN RSA PRIVATE KEY"', max_results: 10 }),
    );
    console.log(show(wide));
    assert.match(wide.summary, /returns at most 1,000|narrow the query/i, 'a capped search did not say so');

    // A missing query is a mistake to raise, not an empty result.
    await assert.rejects(() => byId.github_code_search.run(makeCtx(makeGraph(), [], {})), /Enter a search query/i);
    console.log('  ✓ no selection needed, query not a node, cap reported, empty query throws');
}, true);


// ---- 8. junk in the selection must cost NOTHING -------------------------------------------------
// The host does not filter the selection by `consumes` — neither the UI nor the agent — so a run
// started from "select everything" arrives holding every node in the project. What matters is not
// only that the wrong ones are skipped, but that skipping them opens no request: a lookalike host
// or a coincidentally-named organisation otherwise turns into a real query about a real stranger.
await step('non-GitHub / wrong-type input makes no request at all', async () => {
    const seen = [];
    const dead = (graph, selection, params = {}) => {
        const c = makeCtx(graph, selection, params);
        c.net = { fetch: async (url) => { seen.push(url); throw new Error(`unexpected request: ${url}`); } };
        return c;
    };
    const g8 = makeGraph();
    const mk = async (type, data) => (await g8.createNode({ type, data })).id;
    const junk = [
        await mk('web.url', { url: 'https://example.com/foo/bar' }),                 // unrelated
        await mk('web.url', { url: 'https://github.com.evil.test/o/r' }),            // lookalike host
        await mk('web.url', { url: 'https://gist.github.com/someone/abc123' }),      // THIS PACK creates these
        await mk('web.url', { url: 'https://raw.githubusercontent.com/o/r/main/x' }),// asset host
        await mk('identity.email_address', { email: 'nobody@example.com' }),
        await mk('identity.organization', { name: 'Acme' }),                          // no GitHub evidence
        await mk('identity.organization', { name: 'Acme', website: 'https://acme.example' }),
        await mk('identity.account', { username: 'bob', platform: 'Reddit' }),
    ];
    // github.com's OWN routes are junk to a repository plugin but not to every plugin —
    // /orgs/<name> is a legitimate organisation reference, so it is only asserted where it is junk.
    const ownRoutes = [
        await mk('web.url', { url: 'https://github.com/orgs/acme' }),
        await mk('web.url', { url: 'https://github.com/settings/profile' }),
    ];
    for (const name of ['github_commit_identities', 'github_forks', 'github_pages_domain']) {
        await assert.rejects(() => byId[name].run(dead(g8, [...junk, ...ownRoutes])), /select|None of/i, `${name} did not refuse`);
    }
    for (const name of ['github_account_repos', 'github_gists', 'github_org_members', 'github_gpg_keys']) {
        await assert.rejects(() => byId[name].run(dead(g8, junk)), /select|None of/i, `${name} did not refuse`);
    }
    assert.deepEqual(seen, [], `a request was made for junk input: ${seen[0]}`);
    console.log(`  ✓ 7 plugins over ${junk.length + ownRoutes.length} junk nodes → 0 requests`);
});

// ---- 9. a whole-project run is refused before it starts, not after it stalls --------------------
await step('oversized selection is refused up front', async () => {
    const seen = [];
    const dead = (graph, selection) => {
        const c = makeCtx(graph, selection);
        c.net = { fetch: async (url) => { seen.push(url); throw new Error('should not run'); } };
        return c;
    };
    // Known cost, too large: Account Repositories records commit_count for exactly this check.
    const gA = makeGraph();
    const big = [];
    for (let i = 0; i < 12; i++) {
        big.push((await gA.createNode({ type: 'web.url', data: { url: `https://github.com/o/r${i}`, commit_count: 20000 } })).id);
    }
    await assert.rejects(() => byId.github_commit_identities.run(dead(gA, big)), /more than this plugin will walk/i);

    // Unknown cost, too many: refuse and say the size could not be established.
    const gB = makeGraph();
    const many = [];
    for (let i = 0; i < 25; i++) {
        many.push((await gB.createNode({ type: 'web.url', data: { url: `https://github.com/o/r${i}` } })).id);
    }
    await assert.rejects(() => byId.github_commit_identities.run(dead(gB, many)), /cannot be established|at most/i);

    assert.deepEqual(seen, [], 'the refusal happened after a request had already gone out');
    console.log('  ✓ both refusals happen before the first request');
});


// ---- 10. processed-but-empty is a NORMAL return, never a throw ----------------------------------
// The distinction this pins: a run that could not be carried out (no token, nothing selected of the
// right kind) throws, because on this host a normal return is painted green and would read as a
// verified negative. A run that WAS carried out and found nothing returns — an account with no
// public activity, an organisation with no public members, an empty repository, a deleted account,
// a search with no hits are all finished, correct answers. Conflating the two turns "we looked and
// there is nothing" into "something broke", which is the wrong story in both directions.
await step('a processed request with an empty result returns normally', async () => {
    // A stub that answers every call with a well-formed EMPTY payload.
    const empty = (graph, selection, body, params = {}) => {
        const c = makeCtx(graph, selection, params);
        c.net = { fetch: async (url) => ({
            ok: true, status: 200, headers: {},
            text: async () => JSON.stringify(typeof body === 'function' ? body(url) : body),
        }) };
        return c;
    };
    const g = makeGraph();
    const acct = await g.createNode({ type: 'identity.account', data: { username: 'someone', platform: 'GitHub (User)' } });
    const repo = await g.createNode({ type: 'web.url', data: { url: 'https://github.com/someone/thing' } });
    const org = await g.createNode({ type: 'identity.organization', data: { name: 'Some Org', website: 'https://github.com/someorg' } });

    // Timeline: the account exists, published nothing in the window.
    const t = await byId.github_activity_timeline.run(empty(g, [acct.id], []));
    console.log(show(t));
    assert.equal(t.counts.quiet, 1, 'a silent account was not recorded as read-and-empty');

    // Gists: none published.
    const gi = await byId.github_gists.run(empty(g, [acct.id], []));
    console.log(show(gi));

    // Organisation with no public members.
    const om = await byId.github_org_members.run(empty(g, [org.id], []));
    console.log(show(om));

    // An empty repository: GitHub answers, with no refs at all.
    const er = await byId.github_commit_identities.run(
        empty(g, [repo.id], { data: { repository: { isEmpty: true, defaultBranchRef: null, refs: { nodes: [], pageInfo: {} } } } }),
    );
    console.log(show(er));
    assert.equal(er.counts.repositories, 1, 'an empty repository was not counted as processed');

    // An account GitHub says does not exist.
    const dead = await byId.github_account_repos.run(
        empty(g, [acct.id], (u) => (u.includes('graphql') ? { data: { repositoryOwner: null } } : { items: [] })),
    );
    console.log(show(dead));
    assert.equal(dead.counts.gone, 1, 'a deleted account was not recorded as answered-and-absent');

    // Forks and Pages with nothing to report.
    console.log(show(await byId.github_forks.run(empty(g, [repo.id], []))));
    const pg = makeCtx(g, [repo.id]);
    pg.net = { fetch: async () => ({ ok: false, status: 404, headers: {}, text: async () => '{"message":"Not Found"}' }) };
    console.log(show(await byId.github_pages_domain.run(pg)));

    console.log('  ✓ seven empty-but-processed outcomes, zero throws');
});

// ---- 11. …while an UNPROCESSABLE request still throws -------------------------------------------
await step('an unprocessable request still throws', async () => {
    const g = makeGraph();
    const junk = await g.createNode({ type: 'identity.email_address', data: { email: 'x@y.z' } });
    const noToken = makeCtx(g, [junk.id]);
    noToken.config = {};
    await assert.rejects(() => byId.github_gists.run(noToken), /token is not set/i);
    await assert.rejects(() => byId.github_activity_timeline.run(makeCtx(g, [junk.id])), /names a GitHub account/i);
    await assert.rejects(() => byId.github_commit_identities.run(makeCtx(g, [junk.id])), /is a GitHub repository URL/i);
    console.log('  ✓ no token and nothing targetable both still throw');
});

// ---- 12. GPG keys: fingerprint from the key packet, only VERIFIED addresses become nodes ---------
// Fixture keys made with gpg 2.5; the expected fingerprints are `gpg --show-keys` output. Key A comes
// with its armored block (plus a Comment header and the CRC line the parser must skip) and three
// User IDs; key B the way GitHub serves pre-2017 uploads: raw_key null, only the bare key packet.
await step('GPG Keys: fingerprint, verified-only email nodes, whole selection, 404 = gone', async () => {
    const FP_A = '49e626e1a3a60892e35d8ec044ec478c120a31c6';
    const FP_B = '163caba3f15f2f379ef84e97c60e41098b63d135';
    // RFC 9580 A.3's v6 sample key: SHA-256 with a 4-octet length, key ID = the FIRST 64 bits.
    const FP_C = 'cb186c4f0609a697e4d52dfa6c722b0c1f1e27c18a56708f6525ec27bad9acc9';
    const ARMOR_C = [
        '-----BEGIN PGP PUBLIC KEY BLOCK-----',
        '',
        'xioGY4d/4xsAAAAg+U2nu0jWCmHlZ3BqZYfQMxmZu52JGggkLq2EVD34laPCsQYf',
        'GwoAAABCBYJjh3/jAwsJBwUVCg4IDAIWAAKbAwIeCSIhBssYbE8GCaaX5NUt+mxy',
        'KwwfHifBilZwj2Ul7Ce62azJBScJAgcCAAAAAK0oIBA+LX0ifsDm185Ecds2v8lw',
        'gyU2kCcUmKfvBXbAf6rhRYWzuQOwEn7E/aLwIwRaLsdry0+VcallHhSu4RN6HWaE',
        'QsiPlR4zxP/TP7mhfVEe7XWPxtnMUMtf15OyA51YBM4qBmOHf+MZAAAAIIaTJINn',
        '+eUBXbki+PSAld2nhJh/LVmFsS+60WyvXkQ1wpsGGBsKAAAALAWCY4d/4wKbDCIh',
        'BssYbE8GCaaX5NUt+mxyKwwfHifBilZwj2Ul7Ce62azJAAAAAAQBIKbpGG2dWTX8',
        'j+VjFM21J0hqWlEg+bdiojWnKfA5AQpWUWtnNwDEM0g12vYxoWM8Y81W+bHBw805',
        'I8kWVkXU6vFOi+HWvv/ira7ofJu16NnoUkhclkUrk0mXubZvyl4GBg==',
        '-----END PGP PUBLIC KEY BLOCK-----',
    ].join('\n');
    const ARMOR_A = [
        '-----BEGIN PGP PUBLIC KEY BLOCK-----',
        'Comment: test fixture',
        '',
        'mDMEasT3mxYJKwYBBAHaRw8BAQdAq4bf2SoI0A4Ot861+1jG+2mR1DnNFVdU8zny',
        'Fe7smei0IUZpeHR1cmUgT3duZXIgPG93bmVyQGV4YW1wbGUuY29tPoivBBMWCgBX',
        'FiEESeYm4aOmCJLjXY7AROxHjBIKMcYFAmrE95sbFIAAAAAABAAObWFudTIsMi41',
        'KzEuMTIsMCwzAhsDBQsJCAcCAiICBhUKCQgLAgQWAgMBAh4HAheAAAoJEETsR4wS',
        'CjHGrngBAMc8iPxc5iQwLqORC3uOY9HwZqQ/q3tm59TdhWpwl/I5AP9aY/9s0cPv',
        '4lhXJUXSGHAzBupGMFQQNtEmPt5hfPYqDrQiU29tZW9uZSBFbHNlIDxjbGFpbWVk',
        'QGV4YW1wbGUub3JnPoivBBMWCgBXFiEESeYm4aOmCJLjXY7AROxHjBIKMcYFAmrE',
        '95sbFIAAAAAABAAObWFudTIsMi41KzEuMTIsMCwzAhsDBQsJCAcCAiICBhUKCQgL',
        'AgQWAgMBAh4HAheAAAoJEETsR4wSCjHGsSEBAN5zqczJMRg0HTl5YvvEYMJahyE+',
        'gUcNDbigBHkOypk5AP9b3uYMaq0iqRK/O/kO1mUUfPgdnVMqbpoxjhw+TjlNDLQo',
        'MTIzNDU2NytmaXh0dXJlQHVzZXJzLm5vcmVwbHkuZ2l0aHViLmNvbYivBBMWCgBX',
        'FiEESeYm4aOmCJLjXY7AROxHjBIKMcYFAmrE95sbFIAAAAAABAAObWFudTIsMi41',
        'KzEuMTIsMCwzAhsDBQsJCAcCAiICBhUKCQgLAgQWAgMBAh4HAheAAAoJEETsR4wS',
        'CjHG+hIBALvMKmcPvuzXQ49buiBjHNs3b/eydNDU8WA0xfGA93zvAPoCv83l2DCe',
        'D6scGcRnrygMPI4v0kMU4iobzjDOWeBFDQ==',
        '=ZNMB',
        '-----END PGP PUBLIC KEY BLOCK-----',
    ].join('\n');
    const keysOf = {
        fixture: [
            {
                key_id: '44EC478C120A31C6', raw_key: ARMOR_A, public_key: null, revoked: false,
                expires_at: '2030-01-01T00:00:00.000Z',
                emails: [
                    { email: 'owner@example.com', verified: true },
                    { email: 'claimed@example.org', verified: false },
                    { email: '1234567+fixture@users.noreply.github.com', verified: true },
                ],
            },
            {
                key_id: 'C60E41098B63D135', raw_key: null, revoked: true, expires_at: null,
                public_key: 'mDMEasT3mxYJKwYBBAHaRw8BAQdAuK5HykWgUi5nFbaCWTOu+7t0XS+Rn+Jnpjt6XF8/w0c=',
                // The same verified address on two keys of one account: one account edge, not two.
                emails: [{ email: 'old@example.net', verified: true }, { email: 'owner@example.com', verified: true }],
            },
            { key_id: 'CB186C4F0609A697', raw_key: ARMOR_C, public_key: null, revoked: false, expires_at: null, emails: [] },
        ],
    };
    const stub = (graph, selection, keys = keysOf) => {
        const c = makeCtx(graph, selection);
        c.net = { fetch: async (url) => {
            const login = /\/users\/([^/]+)\/gpg_keys/.exec(url)?.[1];
            return login in keys
                ? { ok: true, status: 200, headers: {}, text: async () => JSON.stringify(keys[login]) }
                : { ok: false, status: 404, headers: {}, text: async () => '{"message":"Not Found"}' };
        } };
        return c;
    };

    const g = makeGraph();
    const acct = await g.createNode({ type: 'identity.account', data: { username: 'fixture', platform: 'GitHub (User)' } });
    const ghost = await g.createNode({ type: 'identity.handle', data: { handle: 'no-such-login' } });
    const res = await byId.github_gpg_keys.run(stub(g, [ghost.id, acct.id]));
    console.log(show(res));
    assert.equal(res.counts.gone, 1, 'a 404 account was not counted as answered-and-absent');

    const keys = [...g.nodes.values()].filter((n) => n.type === 'identity.pgp_key');
    assert.deepEqual(keys.map((k) => k.data.fingerprint).sort(), [FP_A, FP_B, FP_C].sort(), 'fingerprints differ from gpg / RFC 9580');
    assert.equal(keys.find((k) => k.data.fingerprint === FP_C).data.key_id, 'cb186c4f0609a697');
    const a = keys.find((k) => k.data.fingerprint === FP_A);
    const b = keys.find((k) => k.data.fingerprint === FP_B);
    assert.equal(a.data.key_id, '44ec478c120a31c6');
    assert.equal(a.data.creation_time, '2026-10-06');
    assert.equal(a.data.expiration_time, '2030-01-01');
    assert.match(a.data.user_ids, /Someone Else <claimed@example\.org>/, 'the unverified address is not in user_ids');
    assert.equal(a.data.revoked, undefined, 'revoked:false was written and would overwrite a revocation');
    assert.equal(b.data.revoked, true);
    assert.equal(b.data.armored_key, undefined);

    const emails = [...g.nodes.values()].filter((n) => n.type === 'identity.email_address').map((n) => n.data.email);
    assert.deepEqual(emails.sort(), ['old@example.net', 'owner@example.com'], 'only verified real mailboxes may become nodes');
    const owner = [...g.nodes.values()].find((n) => n.data.email === 'owner@example.com');
    assert.equal(g.edges.filter((e) => e.from === acct.id && e.to === owner.id).length, 1, 'duplicate account→email edge');
    assert.match(g.edges.find((e) => e.from === acct.id && e.to === owner.id).label, /registered email on this account/);
    assert.ok(g.edges.some((e) => e.from === b.id && e.to === owner.id && e.label === 'key bound to'));
    assert.ok(g.edges.some((e) => e.from === a.id && e.to === owner.id && e.label === 'key bound to'));
    assert.ok(g.edges.some((e) => e.from === acct.id && e.to === b.id && e.label === 'uploaded this GPG key'));
    // No account is invented for a login GitHub says does not exist.
    assert.equal([...g.nodes.values()].filter((n) => n.type === 'identity.account').length, 1);

    // A key whose packet does not hash to GitHub's key_id is not written; if that is every key, throw.
    const bad = { fixture: [{ ...keysOf.fixture[0], key_id: '0000000000000000' }] };
    await assert.rejects(() => byId.github_gpg_keys.run(stub(g, [acct.id], bad)), /none could be read/);

    // An armored key too big for one node is left off; the key itself must still land.
    const g2 = makeGraph();
    const acct2 = await g2.createNode({ type: 'identity.account', data: { username: 'fixture', platform: 'GitHub (User)' } });
    const huge = { fixture: [{ ...keysOf.fixture[0], raw_key: ARMOR_A.replace('test fixture', 'x'.repeat(200_000)) }] };
    await byId.github_gpg_keys.run(stub(g2, [acct2.id], huge));
    const big = [...g2.nodes.values()].find((n) => n.type === 'identity.pgp_key');
    assert.equal(big?.data.fingerprint, FP_A);
    assert.equal(big.data.armored_key, undefined, 'an armored key over the node data limit was written');
    console.log('  ✓ v4/v6 fingerprints, unverified/relay addresses not nodes, 404 counted, mismatch refused, oversized armor left off');
});

console.log(failures ? `\n✗ ${failures} step(s) failed\n` : '\n✓ all steps passed\n');
process.exit(failures ? 1 : 0);
