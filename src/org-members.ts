// Organisation Public Members — the accounts that have chosen to show their membership.
//
// This is a subset by design: GitHub hides membership unless the member publicises it, so an empty
// or short result says nothing about the real roster. The count GitHub reports for the listing is
// written onto the organisation node so the reader can see how much of it was actually returned.
import { definePlugin } from './sdk';
import type { HostContext, RunResult } from './sdk';
import { GH_PLATFORM, restPaged, lastPage, rest, abortIf } from './gh';

/** The organisation login a selected node stands for. */
function orgOf(node: { type: string; data: Record<string, unknown> }): string | null {
    if (node.type === 'identity.organization') {
        const site = String(node.data?.website ?? '');
        try {
            const u = new URL(site);
            if (/(^|\.)github\.com$/i.test(u.hostname)) {
                const seg = u.pathname.split('/').filter(Boolean);
                if (seg.length === 1) return seg[0];
            }
        } catch {
            /* fall through to the name */
        }
        const n = String(node.data?.name ?? '').trim();
        return /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(n) ? n : null;
    }
    if (node.type === 'web.url') {
        try {
            const u = new URL(String(node.data?.url ?? ''));
            if (!/(^|\.)github\.com$/i.test(u.hostname)) return null;
            const seg = u.pathname.split('/').filter(Boolean);
            if (seg.length === 2 && seg[0].toLowerCase() === 'orgs') return seg[1];
            if (seg.length === 1) return seg[0];
        } catch {
            return null;
        }
    }
    if (node.type === 'identity.account') {
        const p = String(node.data?.platform ?? '').toLowerCase();
        if (p.includes('github')) return String(node.data?.username ?? '').trim() || null;
    }
    return null;
}

export const orgMembers = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.github_org_members',
        content_type: 'vineyard:plugin',
        name: 'GitHub Organisation Members',
        version: '1.0.0',
        description:
            'Lists the members of a GitHub organisation who have made their membership public, as account nodes linked to the organisation. Membership is private by default, so this is a lower bound rather than a roster — the total GitHub reports is recorded on the organisation node so the gap is visible.',
        icon: 'users',
        author: { name: 'VINEYARD', url: 'https://vineyard.run' },
        license: 'Apache-2.0',
        platforms: {
            primary: 'web',
            web: { runtime: 'sandbox-js', entry: 'dist/pack.mjs' },
            desktop: { runtime: 'sandbox-js', entry: 'dist/pack.mjs', min_app_version: '0.1.0' },
        },
        io: {
            consumes: [
                { typepack: 'run.vineyard.typepacks.identity', category: 'identity', name: 'organization' },
                { typepack: 'run.vineyard.typepacks.infrastructure', category: 'web', name: 'url' },
            ],
            produces: [
                { typepack: 'run.vineyard.typepacks.identity', category: 'identity', name: 'account' },
                { typepack: 'run.vineyard.typepacks.identity', category: 'identity', name: 'organization' },
            ],
        },
        params: {
            type: 'object',
            properties: {
                max_members: {
                    type: 'integer',
                    title: 'Maximum members',
                    default: 500,
                    minimum: 1,
                    maximum: 5000,
                    description: 'Read in pages of 100. What was taken versus what exists is recorded on the organisation node.',
                },
            },
        },
        scopes: {
            graph: ['node:read', 'node:create', 'node:update', 'edge:create'],
            network: [
                {
                    endpoint: 'https://api.github.com/orgs',
                    methods: ['GET'],
                    purpose: 'List the public members of the selected organisation.',
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
        if (!ids.length) return { summary: 'Select a GitHub organisation first', counts: {} };
        const cap = Math.max(1, Math.min(5000, Number(ctx.params?.max_members ?? 500)));

        let members = 0;
        let reached = 0;
        let skipped = 0;

        for (let i = 0; i < ids.length; i++) {
            if (abortIf(ctx)) break;
            const seed = await ctx.graph!.get!(ids[i]);
            if (!seed) {
                skipped++;
                continue;
            }
            const org = orgOf(seed as any);
            if (!org) {
                skipped++;
                continue;
            }
            ctx.progress?.set?.({
                percent: Math.round((100 * i) / ids.length),
                message: `${org} (${i + 1}/${ids.length})`,
            });

            const first = await restPaged(ctx, `/orgs/${encodeURIComponent(org)}/public_members?per_page=100`);
            if (!Array.isArray(first.data)) {
                skipped++;
                continue;
            }
            reached++;
            const pages = lastPage(first.link);
            const rows: any[] = [...first.data];
            for (let p = 2; p <= pages && rows.length < cap; p++) {
                if (abortIf(ctx)) break;
                const more = await rest(ctx, `/orgs/${encodeURIComponent(org)}/public_members?per_page=100&page=${p}`);
                if (!Array.isArray(more) || !more.length) break;
                rows.push(...more);
            }

            // Anchor: enrich the selected organisation, or create one.
            let orgId = String(seed.id);
            if (seed.type !== 'identity.organization') {
                const node = await ctx.graph!.createNode!({
                    type: 'identity.organization',
                    data: { name: org, website: `https://github.com/${org}` },
                });
                orgId = String(node.id);
                if (orgId !== String(seed.id)) {
                    await ctx.graph!.createEdge!({ from: String(seed.id), to: orgId, label: 'github organisation' });
                }
            }

            const taken = rows.slice(0, cap);
            for (const m of taken) {
                if (!m?.login) continue;
                const acct = await ctx.graph!.createNode!({
                    type: 'identity.account',
                    data: {
                        username: String(m.login),
                        platform: GH_PLATFORM,
                        user_id: m.id != null ? String(m.id) : undefined,
                        profile_url: `https://github.com/${m.login}`,
                    },
                });
                members++;
                await ctx.graph!.createEdge!({ from: String(acct.id), to: orgId, label: 'member_of' });
            }

            await ctx.graph!.updateNode!(orgId, {
                public_members_listed: taken.length,
                public_members_pages: pages,
            });
        }

        if (!reached) {
            throw new Error(
                `None of the ${ids.length} selected node(s) resolves to a GitHub organisation — select an ` +
                    `Organization node, or a https://github.com/<org> URL.`,
            );
        }

        return {
            summary: `${members} public member(s) across ${reached} organisation(s)${skipped ? ` — ${skipped} skipped` : ''}`,
            counts: { members, organizations: reached, skipped },
        };
    },
});
