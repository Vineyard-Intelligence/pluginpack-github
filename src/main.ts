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
// WHY THERE IS NO CODE SEARCH PLUGIN. GitHub's code search API is reachable from neither egress
// path this host offers, and this was measured rather than assumed:
//   · `net.fetch` is the browser's own fetch and does send the token — but GitHub omits the CORS
//     header from AUTHENTICATED code-search responses specifically (the keyless 401 carries it, the
//     authenticated 200 does not), so the browser discards a response the server did send.
//   · `net.probe` has no CORS to satisfy, but strips `authorization` by design — it is the
//     anonymous path — so it arrives unauthenticated and gets 401.
//   · `?access_token=` in the URL was removed by GitHub in 2021 and now 401s.
// A plugin that could only ever return an empty result would be worse than no plugin, because on
// this host an empty result reads as a completed search that found nothing — the exact false
// negative someone checking whether a key leaked cannot afford.
import { definePluginPack } from './sdk';
import { accountRepos } from './repos';
import { commitIdentities } from './commits';
import { activityTimeline } from './timeline';
import { gists } from './gists';
import { orgMembers } from './org-members';
import { forksWithCommits } from './forks';
import { pagesDomain } from './pages';

export default definePluginPack({
    identifier: 'run.vineyard.pluginpacks.github',
    content_type: 'vineyard:pluginpack',
    name: 'GitHub',
    version: '1.0.0',
    description:
        'Recovers the people behind public GitHub activity. Expands an account into its repositories, then reads commit metadata across every branch and tag — never the code — for the email addresses, display names and former usernames contributors left in it. Also covers gists, organisation membership, activity hours, worked-on forks, and the domain a repository publishes on. Needs a GitHub token.',
    plugins: [accountRepos, commitIdentities, activityTimeline, gists, orgMembers, forksWithCommits, pagesDomain],
});
