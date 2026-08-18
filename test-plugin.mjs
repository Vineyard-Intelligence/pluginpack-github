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
 *
 * The host contract this stands in for, and which the assertions below check:
 *   · run() is called ONCE with the whole selection; the plugin walks it.
 *   · updateNode receives a DELTA, so it must merge, never replace.
 *   · a thrown error is the only failure the host sees — a plain return always reads as success.
 */
import assert from 'node:assert/strict';

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
    console.error('GITHUB_TOKEN is not set');
    process.exit(2);
}
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
        const label = { 'identity.email_address': 'email', 'identity.handle': 'handle', 'web.url': 'url', 'infrastructure.domain': 'domain_name', 'identity.organization': 'name' }[type];
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
        config: { token: TOKEN },
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
async function step(name, fn) {
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
});

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
});

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
});

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
});

// ---- 6. a selection with nothing usable in it must throw ----------------------------------------
await step('wrong node type → throws rather than reporting an empty success', async () => {
    const gx = makeGraph();
    const junk = await gx.createNode({ type: 'identity.email_address', data: { email: 'nobody@example.com' } });
    await assert.rejects(() => byId.github_commit_identities.run(makeCtx(gx, [junk.id])), /is a GitHub repository URL/i);
    console.log('  ✓ throws');
});

console.log(failures ? `\n✗ ${failures} step(s) failed\n` : '\n✓ all steps passed\n');
process.exit(failures ? 1 : 0);
