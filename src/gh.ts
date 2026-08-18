// Shared GitHub API access for every plugin in this pack.
//
// WHY net.fetch AND NOT web_probe: every call here is authenticated, and `probe` strips
// `authorization` by design (desktop/src/main/probe.ts FORBIDDEN_REQUEST_HEADERS) — it is the
// anonymous arbitrary-host path. `net.fetch` passes the header through verbatim and api.github.com
// answers `access-control-allow-origin: *` on every endpoint this pack touches, so the same code
// runs in the browser and in the desktop shell.
//
// `/search/code` is the one endpoint that needs more than that, and the fix is a manifest fact
// rather than a code one. GitHub omits the CORS header from AUTHENTICATED code-search responses
// only (measured: the keyless 401 carries it, the authenticated 200 does not), so a browser
// discards a response the server did send. In the desktop shell the renderer publishes every
// installed plugin's declared network ORIGINS to the main process, which strips `Origin` outbound
// and writes the CORS headers inbound for those origins — so declaring the endpoint is what makes
// Code Search work, and it is desktop-only for that reason alone. `probe` cannot substitute: it
// drops `authorization`, so it would arrive unauthenticated. `?access_token=` was removed by GitHub
// in 2021 and now 401s.
import type { HostContext, GraphNode } from './sdk';

/** The `platform` value every account node in this pack is written with.
 *
 *  Node identity for identity.account is (username, platform) — NOT the label alone — so this
 *  string decides whether an account this pack writes merges with the one a username sweep
 *  already put in the graph. It is spelled exactly as the WhatsMyName dataset spells its GitHub
 *  profile site, because that pack writes `platform: <dataset site name>` and a mismatch here
 *  would silently produce a second node for the same account. Both fields are case-insensitive
 *  in the typepack, so only the words matter — but they must be these words. */
export const GH_PLATFORM = 'GitHub (User)';

export const API = 'https://api.github.com';

/** Read the configured token, or throw.
 *
 *  Throwing rather than returning is the whole contract: the host reports a plugin that RETURNS as
 *  succeeded whatever its counts say, so a missing token would render as a finished collection that
 *  found nothing — indistinguishable, to the analyst and to the agent, from a real negative. The
 *  message is written to be actionable by both. */
export function ghToken(ctx: HostContext): string {
    const t = ctx.config?.token;
    if (typeof t !== 'string' || !t.trim()) {
        throw new Error(
            'GitHub token is not set — add one in this pack\'s settings. Without it the GraphQL API ' +
                'refuses every request, so this is not a "nothing found" result.',
        );
    }
    return t.trim();
}

function authHeaders(token: string, json: boolean): Record<string, string> {
    const h: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    };
    if (json) h['Content-Type'] = 'application/json';
    return h;
}

/** Turn a non-2xx into an error whose message names the endpoint and the status.
 *
 *  Every failure in this pack surfaces this way. A swallowed 401/403 is the specific bug this
 *  guards: it produces an empty run the host paints green. */
async function readOrThrow(res: { ok: boolean; status: number; text(): Promise<string> }, what: string): Promise<any> {
    const body = await res.text();
    if (!res.ok) {
        let msg = body.slice(0, 300);
        try {
            const j = JSON.parse(body);
            if (j?.message) msg = String(j.message);
        } catch {
            /* keep the raw prefix */
        }
        throw new Error(`${what} failed: HTTP ${res.status} — ${msg}`);
    }
    try {
        return JSON.parse(body);
    } catch {
        throw new Error(`${what}: response was not JSON (${body.slice(0, 120)})`);
    }
}

/** One GraphQL call. Throws on transport failure, HTTP failure, or a GraphQL `errors` block.
 *
 *  GraphQL answers 200 with an `errors` array for things REST would 404 on, so not checking it
 *  would turn "no such user" into "this user has no repositories". */
export async function gql(ctx: HostContext, query: string, variables: Record<string, unknown>): Promise<any> {
    const res = await ctx.net!.fetch!(`${API}/graphql`, {
        method: 'POST',
        headers: authHeaders(ghToken(ctx), true),
        body: JSON.stringify({ query, variables }),
    });
    const j = await readOrThrow(res, 'GitHub GraphQL');
    if (Array.isArray(j.errors) && j.errors.length) {
        throw new Error(`GitHub GraphQL: ${j.errors.map((e: any) => e?.message ?? String(e)).join('; ')}`);
    }
    return j.data;
}

/** One REST GET. `path` starts with a slash. */
export async function rest(ctx: HostContext, path: string): Promise<any> {
    const res = await ctx.net!.fetch!(`${API}${path}`, {
        method: 'GET',
        headers: authHeaders(ghToken(ctx), false),
    });
    return readOrThrow(res, `GitHub ${path.split('?')[0]}`);
}

/** REST GET that returns the parsed body AND the Link header, for callers that need the page count. */
export async function restPaged(ctx: HostContext, path: string): Promise<{ data: any; link: string }> {
    const res = await ctx.net!.fetch!(`${API}${path}`, {
        method: 'GET',
        headers: authHeaders(ghToken(ctx), false),
    });
    const link = res.headers?.link ?? res.headers?.Link ?? '';
    return { data: await readOrThrow(res, `GitHub ${path.split('?')[0]}`), link };
}

/** Total pages behind a Link header, from its rel="last". 1 when the header says nothing. */
export function lastPage(link: string): number {
    const m = /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link ?? '');
    return m ? Number(m[1]) : 1;
}

// ---- identifying the things the analyst selected -------------------------------------------

/**
 * Is this the github.com web host — and ONLY that?
 *
 * Nothing but `github.com` and `www.github.com`. Not a subdomain, and the distinction is not
 * academic: this started as /(^|\.)github\.com$/, which also matched `gist.github.com` — so a gist
 * URL parsed as owner/repo and got queried as a repository. THIS PACK PRODUCES THOSE NODES: the
 * Gists plugin writes one `https://gist.github.com/<user>/<id>` per gist, so selecting a whole
 * project and running the commit walk sent GitHub a request for a repository that never existed,
 * off a node the pack had created itself. Same for `raw.githubusercontent.com` and
 * `objects.githubusercontent.com`, which appear in any graph that has touched a file URL.
 *
 * The trailing `$` is what refuses `github.com.evil.test`, and that is deliberate too — an
 * allowlist that can be widened by choosing a hostname is not one.
 */
const isGithubWebHost = (h: string): boolean => /^(www\.)?github\.com$/i.test(h);

/** Path segments that are github.com's own routes, not an account or an owner. */
const RESERVED_OWNER = new Set([
    'orgs', 'users', 'settings', 'search', 'topics', 'collections', 'sponsors', 'about', 'pricing',
    'features', 'security', 'enterprise', 'marketplace', 'explore', 'notifications', 'issues',
    'pulls', 'codespaces', 'new', 'login', 'join', 'apps', 'contact', 'site', 'readme', 'trending',
]);

/** Path segments that are a repository's own routes, so `/owner/repo/tree/main` still resolves to
 *  `owner/repo` rather than being mistaken for something else. */
const isRepoSubroute = (seg: string): boolean =>
    ['tree', 'blob', 'commits', 'commit', 'issues', 'pull', 'pulls', 'releases', 'tags', 'wiki',
     'actions', 'projects', 'security', 'pulse', 'graphs', 'settings', 'branches', 'compare'].includes(seg.toLowerCase());

/** `owner/name` from a GitHub repository URL, or null when the node is not one. */
export function repoOf(node: GraphNode): { owner: string; name: string; url: string } | null {
    const raw = typeof node.data?.url === 'string' ? node.data.url : '';
    if (!raw) return null;
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return null;
    }
    if (!isGithubWebHost(u.hostname)) return null;
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg.length < 2) return null;
    if (RESERVED_OWNER.has(seg[0].toLowerCase())) return null;
    // A deeper path is fine as long as the third segment is a repository route — anything else is
    // some other github.com page that happens to be two segments deep.
    if (seg.length > 2 && !isRepoSubroute(seg[2])) return null;
    const name = seg[1].replace(/\.git$/i, '');
    if (!name) return null;
    return { owner: seg[0], name, url: `https://github.com/${seg[0]}/${name}` };
}

/** The GitHub login a selected node stands for: an account's username, or the owner segment of a
 *  github.com profile URL. Null when the node names neither. */
export function loginOf(node: GraphNode): string | null {
    if (node.type === 'identity.account' || node.type === 'social.account') {
        const p = String(node.data?.platform ?? '').toLowerCase();
        // Accept any GitHub-ish platform spelling on INPUT — a graph may hold accounts written by
        // other packs — while everything this pack WRITES uses GH_PLATFORM verbatim.
        if (!p.includes('github')) return null;
        const u = String(node.data?.username ?? node.data?.handle ?? '').trim();
        return u || null;
    }
    if (node.type === 'identity.handle') {
        const h = String(node.data?.handle ?? '').trim();
        return h || null;
    }
    if (node.type === 'web.url') {
        const raw = typeof node.data?.url === 'string' ? node.data.url : '';
        try {
            const u = new URL(raw);
            // github.com only. `gist.github.com/<user>/<id>` is two segments and would otherwise be
            // rejected anyway, but the host check is what keeps every other *.github.com page out.
            if (!isGithubWebHost(u.hostname)) return null;
            const seg = u.pathname.split('/').filter(Boolean);
            if (seg.length !== 1) return null; // /owner only — /owner/repo is a repository
            if (RESERVED_OWNER.has(seg[0].toLowerCase())) return null;
            return seg[0];
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * The GitHub organisation a selected node stands for — and null unless the node actually EVIDENCES
 * one.
 *
 * The bare-name fallback that used to live here was a false-attribution bug: an
 * `identity.organization` named "Acme", written by any other pack or by hand, was queried as
 * `github.com/orgs/Acme`, and whatever unrelated GitHub organisation happened to own that name had
 * its members attached to it. In a forensics graph an invented edge is worse than a missing one, so
 * the name alone is no longer enough — a github.com URL has to say so.
 */
export function orgOf(node: GraphNode): string | null {
    if (node.type === 'identity.organization') {
        for (const field of ['website', 'url', 'profile_url'] as const) {
            const v = String((node.data as any)?.[field] ?? '');
            if (!v) continue;
            try {
                const u = new URL(v);
                if (!isGithubWebHost(u.hostname)) continue;
                const seg = u.pathname.split('/').filter(Boolean);
                if (seg.length === 2 && seg[0].toLowerCase() === 'orgs') return seg[1];
                if (seg.length === 1 && !RESERVED_OWNER.has(seg[0].toLowerCase())) return seg[0];
            } catch {
                /* not a URL — try the next field */
            }
        }
        return null;
    }
    if (node.type === 'web.url') {
        try {
            const u = new URL(String(node.data?.url ?? ''));
            if (!isGithubWebHost(u.hostname)) return null;
            const seg = u.pathname.split('/').filter(Boolean);
            if (seg.length === 2 && seg[0].toLowerCase() === 'orgs') return seg[1];
            if (seg.length === 1 && !RESERVED_OWNER.has(seg[0].toLowerCase())) return seg[0];
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

// ---- commit author email classification ------------------------------------------------------

/** GitHub's per-user relay address. Not a mailbox and not a discovered identity — it is a
 *  re-encoding of the login the caller already has, so it must never become an email node. Its
 *  `{digits}+` prefix IS worth keeping: that number is the account id, which survives a rename. */
const NOREPLY = /^(?:(\d+)\+)?([^@]+)@users\.noreply\.github\.com$/i;

/** Addresses that identify nobody: git's unconfigured default and GitHub's web-flow committer. */
const PLACEHOLDER = new Set(['you@example.com', 'noreply@github.com', 'root@localhost', 'user@example.com']);

export interface AuthorEmail {
    /** A real mailbox worth a node, or null. */
    email: string | null;
    /** Account id recovered from a noreply address ({digits}+login@…). */
    userId: string | null;
    /** The login embedded in a noreply address — which may be a FORMER username. */
    noreplyLogin: string | null;
}

export function classifyEmail(raw: string): AuthorEmail {
    const e = (raw ?? '').trim();
    if (!e || PLACEHOLDER.has(e.toLowerCase())) return { email: null, userId: null, noreplyLogin: null };
    const m = NOREPLY.exec(e);
    if (m) return { email: null, userId: m[1] ?? null, noreplyLogin: m[2] ?? null };
    return { email: e, userId: null, noreplyLogin: null };
}

export const domainOf = (email: string): string => email.slice(email.lastIndexOf('@') + 1).toLowerCase();

/** Stop early when the analyst cancels, at a point where the partial result is still coherent. */
export function abortIf(ctx: HostContext): boolean {
    return !!ctx.signal?.aborted;
}
