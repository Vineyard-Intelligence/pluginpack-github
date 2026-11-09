// GitHub pack — recovers the people behind public GitHub activity.
//
// The pack's shape follows one measured fact: a repository's commit metadata still carries the
// email address each contributor wrote it under, and enabling GitHub's email privacy does not
// rewrite history. So a person whose recent commits are all relayed through a noreply address can
// still be sitting in plain text in a repository from three years ago, alongside the username they
// used at the time.
//
// The entry point is GitHub Account Repositories: it turns one account into the repository nodes
// everything else consumes, and stamps each with its commit count so the cost of scanning it is
// visible in advance.
//
// WHY EVERY PLUGIN NEEDS A TOKEN. GitHub allows 60 unauthenticated requests an hour, which is not
// enough to finish a single repository, and the GraphQL API — which is what makes the commit walk
// affordable at all — refuses unauthenticated requests outright. Rather than ship a keyless path
// that fails differently on every plugin, the token is required for all of them and its absence is
// raised as an error, never returned as an empty result.
//
// CODE SEARCH IS DESKTOP-ONLY, and the reason is worth recording because it is not general. GitHub
// answers `access-control-allow-origin: *` on every endpoint this pack uses EXCEPT authenticated
// code search, where it omits the header entirely — the keyless 401 carries it, the authenticated
// 200 does not. A browser therefore discards a response the server did send.
//
// The desktop shell resolves this through the manifest, not through code: the renderer publishes
// every installed plugin's declared `network` ORIGINS to the main process, which then strips
// `Origin` outbound and writes the CORS headers inbound for exactly those origins. So declaring the
// endpoint is what makes the plugin work, and the request GitHub sees is an ordinary API call.
import { definePluginPack } from './sdk';
import { accountRepos } from './repos';
import { commitIdentities } from './commits';
import { activityTimeline } from './timeline';
import { gists } from './gists';
import { orgMembers } from './org-members';
import { forksWithCommits } from './forks';
import { pagesDomain } from './pages';
import { codeSearch } from './code-search';
import { gpgKeys } from './gpg-keys';

// The pack's page in the catalog, in Markdown: the About section the marketplace drawer shows
// below the one-line `summary`. Kept as an array of lines rather than a template literal so the
// Markdown's backticks need no escaping.
const PACK_PAGE = [
    "For attributing public GitHub activity to the people behind it. Commit metadata keeps the email address each contributor committed under, and turning on GitHub's email privacy later does not rewrite that history: an account whose recent commits go through a `users.noreply.github.com` relay can still appear in plain text in an older repository, next to the username it had then. Start with GitHub Account Repositories; the `commit_count` it writes shows whether scanning a repository is a few requests or a few hundred. Fork owners are often missing from the upstream history, because work in a fork stays there unless a pull request is merged; run Commit Identities on the fork URLs.",
    '',
    "**Needs:** a token although everything read is public. GitHub's GraphQL API refuses unauthenticated requests, and the unauthenticated limit of 60 requests an hour would not finish one repository.",
    '',
    "**Who sees it:** only GitHub. Every request carries the analyst's token, so GitHub can tie the lookups to its owner. Pages sites, repository web pages and other hosts the results point to are never visited.",
    '',
    '**Read results with care:**',
    '',
    "- An address that belongs to no GitHub account is the author's raw local git configuration value and can carry a machine hostname.",
    "- Activity hours come from about 300 recent events, so a busy account's window may be a week. Automation produces the tightest hour distributions: a sharp result may be a scheduler.",
    '- Code Search: read an empty result as "not found in what was searched", not "not on GitHub"; narrow with `user:`, `org:` or `repo:` until GitHub\'s total is under 1,000.',
    '',
    '**Source:** https://github.com/Vineyard-Intelligence/pluginpack-github (Apache-2.0)',
].join('\n');

export default definePluginPack({
    identifier: 'run.vineyard.pluginpacks.github',
    content_type: 'vineyard:pluginpack',
    name: 'GitHub',
    version: '1.5.1',
    summary:
        'Collects public GitHub data: repositories, commit identities, gists, organisation members, activity hours, worked-on forks, Pages domains, GPG keys and code search. Token: fine-grained (Public repositories, no permissions) or classic with no scopes.',
    description: PACK_PAGE,
    plugins: [accountRepos, commitIdentities, activityTimeline, gists, orgMembers, forksWithCommits, pagesDomain, gpgKeys, codeSearch],
});
