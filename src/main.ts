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
    "For attributing public GitHub activity to the people behind it. The pack rests on one fact: a repository's commit metadata keeps the email address each contributor committed under, and turning on GitHub's email privacy later does not rewrite that history. An account whose recent commits all go through a `users.noreply.github.com` relay address can still appear in plain text in an older repository, next to the username it had at the time.",
    '',
    'Start with **GitHub Account Repositories**. It turns one account into the repository nodes most of the other plugins run on, and the `commit_count` it writes on each shows in advance whether scanning a repository is a few requests or a few hundred.',
    '',
    'Nodes a plugin cannot use are dropped before any request is made, so running on a mixed selection is safe. Only `github.com` and `www.github.com` URLs count, and an organisation is queried only when a github.com URL says it is one. A run that could not be carried out (no token, or nothing usable selected) fails with an error. A run that was carried out and found nothing succeeds, and its summary says which case it was.',
    '',
    '## Plugins',
    '',
    '### GitHub Account Repositories',
    '',
    '- **Runs on:** Account, Handle, or a github.com profile URL.',
    "- **Adds:** the account's owned repositories as URL nodes carrying `commit_count`, linked `owns repository` (`organisation repository` for an organisation), and the organisations it belongs to as Organization nodes (`member_of`). Writes `user_id` (GitHub's numeric id), `display_name` and `profile_url` on the Account, creating it (linked `github account`) when a Handle or URL was selected.",
    '- **Options:** `include_forks` (off) also adds owned forks, marked `is_fork`. `include_contributed` (on) also adds repositories the account committed to but does not own, linked `committed to this repository`.',
    '- **Limits:** up to 1,000 owned repositories and 20 organisations; contributed repositories come from the first 100 commit-search results.',
    '',
    '### GitHub Commit Identities',
    '',
    '- **Runs on:** github.com repository URLs.',
    "- **Reads:** the author name, email and linked login of every commit on all branches and tags, or the default branch only with `all_refs` off. Commit metadata only; no file contents or diffs are fetched. The committer field is never read: it is mostly `noreply@github.com`, one address shared by everyone who merges in GitHub's web interface.",
    '- **Adds:** each linked GitHub Account (`authored commits in this repository`) with the addresses it committed under as Email Address nodes. Addresses that belong to no GitHub account are kept too, linked to the repository: they are the raw local git configuration value and can carry a machine hostname. A relay address that spells a different login is recorded as a former username, a Handle that `resolves_to` the current Account.',
    "- **Skipped:** relay and placeholder addresses (as email nodes) and `[bot]` logins. The numeric prefix of a relay address is kept as the account's id, which survives a rename.",
    "- **Limits:** a run over 100,000 commits (the summed `commit_count` from Account Repositories, or one repository's default branch) is refused before it starts and the refusal names the total. With no `commit_count` known, a run over 20 repositories is refused instead.",
    '',
    '### GitHub Activity Timeline',
    '',
    '- **Runs on:** Account, Handle, or profile URL.',
    '- **Adds:** no nodes. Writes `activity_hours_utc` (24 hourly counts, UTC), `events_sampled`, `activity_window_start`, `activity_window_end` and `event_types` onto the Account, creating it when a Handle or URL was selected.',
    "- **Limits:** GitHub serves about 300 recent public events over at most 90 days, so a busy account's window may be a week and a quiet one's the full 90 days; the event count and window are written for that reason. Automation produces the tightest hour distributions, so a sharp result may be a scheduler.",
    '',
    '### GitHub Gists',
    '',
    '- **Runs on:** Account, Handle, or profile URL.',
    '- **Adds:** each public gist as a URL node (`published this gist`) with its description, `file_names`, `languages`, `file_count` and dates. File names stay properties, because generic names such as `gistfile1.txt` would otherwise join unrelated owners.',
    '- **Limits:** `max_gists` per account, default 300, at most 3,000.',
    '',
    '### GitHub Organisation Members',
    '',
    '- **Runs on:** an Organization whose website is a github.com URL, or a `github.com/<org>` URL.',
    '- **Adds:** the members who made their membership public, as Account nodes linked `member_of`. Writes `public_members_listed` and `public_members_pages` on the Organization, creating it (linked `github organisation`) when a URL was selected. Private memberships are not visible.',
    '- **Limits:** `max_members`, default 500, at most 5,000.',
    '',
    '### GitHub Forks With Own Commits',
    '',
    '- **Runs on:** github.com repository URLs.',
    "- **Adds:** forks pushed to after they were created, as URL nodes (`forked from, and pushed to since`), each with its owner's Account (`owns this fork`). Writes `forks_examined` on the repository. Work done in a fork stays there unless a pull request is merged, so these owners are often missing from the upstream commit history; running Commit Identities on a fork URL follows them up.",
    '- **Options:** `worked_only` (on). Off adds every fork examined.',
    '- **Limits:** `max_forks` per repository, newest first, default 200, at most 5,000.',
    '',
    '### GitHub Pages Domain',
    '',
    '- **Runs on:** github.com repository URLs.',
    "- **Adds:** the custom or `github.io` domain of the repository's GitHub Pages site as a Domain node, and the site as a URL node (`published site`), both linked to the repository. A repository without a Pages site adds nothing. The Domain node can be carried on by DNS, certificate and IP plugins.",
    '',
    '### GitHub GPG Keys',
    '',
    '- **Runs on:** Account, Handle, or profile URL.',
    '- **Adds:** each uploaded GPG key as a PGP Key node (fingerprint, `key_id`, creation and expiration date, `user_ids`, revocation, armored key) linked `uploaded this GPG key`, and each address GitHub has verified on the account as an Email Address node, linked `registered email on this account (GitHub GPG key)` from the Account and `key bound to` from the key.',
    '- **Not added:** unverified addresses. They are text the uploader typed into their own key, so they stay in its `user_ids`.',
    '',
    '### GitHub Code Search',
    '',
    '- **Runs on:** no selection; a query in GitHub code search syntax, entered in the Run dialog.',
    "- **Adds:** each match as a URL node linked to its repository's URL node, plus the owner's Account (`owns repository`).",
    '- **Limits:** GitHub searches only the default branches of indexed repositories and returns at most 1,000 results for any query; `max_results` defaults to 300. The summary reports GitHub\'s total next to what was retrieved. Narrow the query with `user:`, `org:` or `repo:` until the total is under 1,000, and read an empty result as "not found in what was searched", not "not on GitHub".',
    '- **Desktop only.**',
    '',
    '## Requirements',
    '',
    '- **A GitHub personal access token**, set in the pack\'s settings and required by every plugin: fine-grained with Repository access "Public repositories" and no permissions, or classic with no scopes. Everything the pack reads is public. Without a token GitHub\'s GraphQL API refuses requests, and the unauthenticated limit of 60 requests an hour would not finish one repository.',
    '- **The Vineyard desktop app for GitHub Code Search.** GitHub omits the CORS header from authenticated code-search responses, so a browser cannot read them. The other eight plugins work in the browser and in the desktop app.',
    '',
    '## What it contacts',
    '',
    "Only the GitHub API at https://api.github.com (GraphQL and REST), directly from the analyst's browser or desktop app. Every request carries the analyst's token, so GitHub can associate the lookups with the account that owns it. The token is sent nowhere else. The pack does not visit Pages sites, repository web pages or any other host the collected data points to.",
    '',
    '## Source',
    '',
    'https://github.com/Vineyard-Intelligence/pluginpack-github',
    '',
    'Licensed Apache-2.0. The bundle `dist/pack.mjs` is built from `src/` with a pinned esbuild, and `plugins/github.manifest.json` is generated from the built bundle, so the declared scopes, parameters and versions match the code.',
].join('\n');

export default definePluginPack({
    identifier: 'run.vineyard.pluginpacks.github',
    content_type: 'vineyard:pluginpack',
    name: 'GitHub',
    version: '1.5.0',
    summary:
        'Collects public GitHub data: repositories, commit identities, gists, organisation members, activity hours, worked-on forks, Pages domains, GPG keys and code search. Token: fine-grained (Public repositories, no permissions) or classic with no scopes.',
    description: PACK_PAGE,
    plugins: [accountRepos, commitIdentities, activityTimeline, gists, orgMembers, forksWithCommits, pagesDomain, gpgKeys, codeSearch],
});
