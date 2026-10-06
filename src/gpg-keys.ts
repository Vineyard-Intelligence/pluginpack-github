// GPG Keys — the OpenPGP keys an account has uploaded to GitHub, and the addresses GitHub has
// verified on it.
//
// The value is the `verified` flag on each key's emails[]. verified:true means GitHub has confirmed
// that address on THIS account — a platform-made account→mailbox binding that the profile (one
// public email at most) and commit history (only addresses actually committed under) do not give.
// verified:false is only a User ID the uploader typed into their own key, and anyone can put anyone's
// address there, so it never becomes an email node: it stays in the key's user_ids text.
//
// The pgp_key node is labelled by the full fingerprint, which GitHub does not return (key_id is the
// 16-hex long ID), so it is recomputed from the key packet. That is what makes a key found here and
// the same key found by PGP Key Lookup one node.
import { definePlugin } from './sdk';
import type { HostContext, RunResult } from './sdk';
import { ghToken, GH_PLATFORM, rest, loginOf, abortIf, classifyEmail, domainOf } from './gh';

/** Packets of a binary OpenPGP stream as [tag, body]. Stops at anything it cannot frame; partial
 *  lengths and old-format indeterminate lengths do not occur in a transferable public key. */
function* packets(b: Uint8Array): Generator<[number, Uint8Array]> {
    const num = (at: number, n: number): number => {
        let v = 0;
        for (let i = 0; i < n; i++) v = v * 256 + b[at + i];
        return v;
    };
    let p = 0;
    while (p < b.length && b[p] & 0x80) {
        const h = b[p];
        let tag: number;
        let len: number;
        let at: number;
        if (h & 0x40) {
            tag = h & 0x3f;
            const l = b[p + 1];
            if (l < 192) [len, at] = [l, p + 2];
            else if (l < 224) [len, at] = [((l - 192) << 8) + b[p + 2] + 192, p + 3];
            else if (l === 255) [len, at] = [num(p + 2, 4), p + 6];
            else return;
        } else {
            tag = (h >> 2) & 0x0f;
            const n = [1, 2, 4][h & 3];
            if (!n) return;
            [len, at] = [num(p + 1, n), p + 1 + n];
        }
        if (at + len > b.length) return;
        yield [tag, b.subarray(at, at + len)];
        p = at + len;
    }
}

/** Bytes of an armored block: armor headers carry ':' and the CRC line starts with '=', and
 *  neither can occur in a base64 data line. */
function dearmor(armor: string): Uint8Array | null {
    const m = /-----BEGIN PGP PUBLIC KEY BLOCK-----([\s\S]*?)-----END PGP PUBLIC KEY BLOCK-----/.exec(armor);
    if (!m) return null;
    return b64(m[1].split(/\r?\n/).filter((l) => !l.includes(':') && !l.trim().startsWith('=')).join(''));
}

function b64(s: string): Uint8Array | null {
    try {
        return Uint8Array.from(atob(s.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
    } catch {
        return null;
    }
}

/** Longest armored key written onto the node — half the server's per-node data limit. */
const ARMOR_MAX = 128 * 1024;

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const isoDate = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 10);

interface KeyFacts {
    fingerprint: string;
    keyId: string;
    created: string;
    userIds: string[];
}

/**
 * Fingerprint, long key ID, creation date and User IDs of the primary key in `bytes`.
 *
 * v4 (RFC 4880): SHA-1 over 0x99 ‖ 2-octet length ‖ body, key ID = the LAST 64 bits.
 * v5 (LibrePGP) and v6 (RFC 9580): SHA-256 over 0x9A / 0x9B ‖ 4-octet length ‖ body, key ID = the
 * FIRST 64 bits. v3 and older are null: their MD5 fingerprint is not what pgp_key's label holds.
 */
async function keyFacts(bytes: Uint8Array): Promise<KeyFacts | null> {
    let facts: KeyFacts | null = null;
    for (const [tag, body] of packets(bytes)) {
        if (tag === 6) {
            if (facts) break; // a second primary key is a second certificate
            const v = body[0];
            if (v < 4 || v > 6) return null;
            const n = body.length;
            const pre = v === 4 ? [0x99, n >> 8, n & 0xff] : [0x95 + v, n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
            const msg = new Uint8Array(pre.length + n);
            msg.set(pre);
            msg.set(body, pre.length);
            const fp = hex(new Uint8Array(await crypto.subtle.digest(v === 4 ? 'SHA-1' : 'SHA-256', msg)));
            facts = {
                fingerprint: fp,
                keyId: v === 4 ? fp.slice(-16) : fp.slice(0, 16),
                created: isoDate(((body[1] << 24) >>> 0) + (body[2] << 16) + (body[3] << 8) + body[4]),
                userIds: [],
            };
        } else if (tag === 13 && facts) {
            facts.userIds.push(new TextDecoder().decode(body));
        }
    }
    return facts;
}

export const gpgKeys = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.github_gpg_keys',
        content_type: 'vineyard:plugin',
        name: 'GitHub GPG Keys',
        version: '1.0.0',
        description:
            'Reads the GPG keys uploaded to each selected GitHub account, handle or profile URL. Adds each key as a PGP Key node (fingerprint, key_id, creation and expiration date, user_ids, revocation, armored key) linked \'uploaded this GPG key\', and each address GitHub has verified on the account as an Email Address node linked \'registered email on this account (GitHub GPG key)\' from the Account and \'key bound to\' from the key. Unverified addresses stay in the key\'s user_ids. Creates the Account (\'github account\') when a handle or URL is selected. Needs a GitHub token.',
        icon: 'key',
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
                { typepack: 'run.vineyard.typepacks.identity', category: 'identity', name: 'pgp_key' },
                { typepack: 'run.vineyard.typepacks.identity', category: 'identity', name: 'email_address' },
                // The account, when a handle or profile URL is selected instead of an account node.
                { typepack: 'run.vineyard.typepacks.identity', category: 'identity', name: 'account' },
            ],
        },
        scopes: {
            graph: ['node:read', 'node:create', 'edge:create'],
            network: [
                {
                    endpoint: 'https://api.github.com/users',
                    methods: ['GET'],
                    purpose: 'List the GPG keys uploaded to the selected account.',
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
        // Token first, before anything about the selection is judged — same reason as every plugin
        // in this pack: "no token" is the message the analyst can act on.
        ghToken(ctx);

        let keys = 0;
        let emails = 0;
        let reached = 0;
        let gone = 0;
        let unreadable = 0;
        let skipped = 0;

        for (let i = 0; i < ids.length; i++) {
            if (abortIf(ctx)) break;
            const seed = await ctx.graph!.get!(ids[i]);
            const login = seed ? loginOf(seed) : null;
            if (!seed || !login) {
                skipped++;
                continue;
            }
            reached++;
            ctx.progress?.set?.({
                percent: Math.round((100 * i) / ids.length),
                message: `${login} (${i + 1}/${ids.length})`,
            });

            // ponytail: first 100 keys only; an account with more is not a case anyone has met.
            let rows: any[];
            try {
                rows = await rest(ctx, `/users/${encodeURIComponent(login)}/gpg_keys?per_page=100`);
            } catch (e: any) {
                // 404 is GitHub answering "no such account" — a finished, empty answer, not a reason
                // to discard the rest of the selection. Everything else (401, rate limit) is raised.
                if (/HTTP 404\b/.test(String(e?.message))) {
                    gone++;
                    continue;
                }
                throw e;
            }
            if (!Array.isArray(rows) || !rows.length) continue;

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

            // One account edge per address: two keys of one account often carry the same addresses,
            // and the host keeps a single edge per node pair.
            const linked = new Set<string>();
            for (const k of rows) {
                // raw_key is null on keys uploaded before GitHub kept the armored block (seen on
                // 2016 uploads); public_key — the bare key packet — still gives the fingerprint.
                const bytes = typeof k?.raw_key === 'string' ? dearmor(k.raw_key) : b64(String(k?.public_key ?? ''));
                const f = bytes ? await keyFacts(bytes) : null;
                // GitHub's own key_id must match what was computed, or this is not the key it means.
                if (!f || f.keyId !== String(k?.key_id ?? '').toLowerCase()) {
                    unreadable++;
                    continue;
                }
                const data: Record<string, unknown> = { fingerprint: f.fingerprint, key_id: f.keyId, creation_time: f.created };
                if (f.userIds.length) data.user_ids = f.userIds.join('\n');
                if (typeof k.expires_at === 'string') data.expiration_time = k.expires_at.slice(0, 10);
                // Only a positive: `false` would overwrite a revocation another directory reported.
                if (k.revoked === true) data.revoked = true;
                // raw_key keeps every third-party signature it was uploaded with. The server refuses a
                // node whose data is over 256 KB, and that refusal drops the key and its edges too.
                if (typeof k.raw_key === 'string' && k.raw_key.length <= ARMOR_MAX) data.armored_key = k.raw_key;
                const key = await ctx.graph!.createNode!({ type: 'identity.pgp_key', data });
                keys++;
                await ctx.graph!.createEdge!({ from: owner, to: String(key.id), label: 'uploaded this GPG key' });

                for (const e of Array.isArray(k.emails) ? k.emails : []) {
                    if (e?.verified !== true) continue;
                    // A relay or placeholder address is not a mailbox, verified or not.
                    const addr = classifyEmail(String(e.email ?? '')).email;
                    if (!addr) continue;
                    const em = await ctx.graph!.createNode!({
                        type: 'identity.email_address',
                        data: { email: addr, domain: domainOf(addr) },
                    });
                    await ctx.graph!.createEdge!({ from: String(key.id), to: String(em.id), label: 'key bound to' });
                    if (linked.has(addr.toLowerCase())) continue;
                    linked.add(addr.toLowerCase());
                    emails++;
                    await ctx.graph!.createEdge!({
                        from: owner,
                        to: String(em.id),
                        label: 'registered email on this account (GitHub GPG key)',
                    });
                }
            }
        }

        if (!reached) {
            throw new Error(
                `None of the ${ids.length} selected node(s) name a GitHub account — select an Account, ` +
                    `Handle, or https://github.com/<login> URL.`,
            );
        }

        // Keys were returned and none could be read: on this host a plain return would read as
        // "this account has no keys", which is the one answer that is known to be false.
        if (!keys && unreadable) {
            throw new Error(`${unreadable} GPG key(s) were returned but none could be read (unsupported key version or a key_id mismatch).`);
        }

        return {
            summary:
                `${keys} GPG key(s) and ${emails} verified email address(es) from ${reached} account(s)` +
                (gone ? `, ${gone} account(s) no longer exist on GitHub` : '') +
                (unreadable ? ` — ${unreadable} key(s) could not be read` : '') +
                (skipped ? ` — ${skipped} skipped` : ''),
            counts: { keys, emails, accounts: reached, gone, unreadable, skipped },
        };
    },
});
