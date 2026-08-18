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

export default definePluginPack({
    identifier: 'run.vineyard.pluginpacks.github',
    content_type: 'vineyard:pluginpack',
    name: 'GitHub',
    version: '1.2.0',
    description:
        'Recovers the people behind public GitHub activity. Expands an account into its repositories, then reads commit metadata across every branch and tag — never the code — for the email addresses, display names and former usernames contributors left in it. Also covers gists, organisation membership, activity hours, worked-on forks, Pages domains, and code search across every public repository. Needs a GitHub token.',
    plugins: [accountRepos, commitIdentities, activityTimeline, gists, orgMembers, forksWithCommits, pagesDomain, codeSearch],
});
