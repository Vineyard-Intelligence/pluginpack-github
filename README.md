# GitHub — a Vineyard plugin pack

Recovers the people behind public GitHub activity.

The pack exists because of one durable fact: **a repository's commit metadata still carries the
email address each contributor wrote it under, and turning on GitHub's email privacy does not
rewrite history.** An account whose recent commits are all relayed through a `users.noreply` address
can still be sitting in plain text in a repository from three years ago — next to the username they
used at the time.

## Plugins

| Plugin | Takes | Produces |
| --- | --- | --- |
| **Account Repositories** | an account, handle, or profile URL | one URL node per repository, each stamped with its commit count; the account enriched with GitHub's profile and its numeric id |
| **Commit Identities** | repository URLs | the accounts, email addresses and former usernames found in commit metadata across every branch and tag |
| **Activity Timeline** | an account | UTC activity hours written **onto the account** — no new nodes |
| **Gists** | an account | one URL node per public gist |
| **Organisation Members** | an organisation | the members who made their membership public |
| **Forks With Own Commits** | repository URLs | fork owners who actually pushed to their copy, and the fork URL to follow them into |
| **Pages Domain** | repository URLs | the domain a repository publishes on — the step that leaves GitHub |
| **Code Search** | a query, no node | repositories and accounts whose code matches. Desktop only |

Start with **Account Repositories**: it turns one account into the repository nodes the rest of the
pack consumes, and the commit count it writes on each is what tells you whether scanning it is a few
requests or a few hundred.

## Setup

Add a GitHub personal access token in the pack's settings. A token with no scopes selected is
enough — everything here reads public data. Every plugin requires it; without one the run fails with
an error rather than returning an empty result.

Without a token GitHub allows 60 requests an hour, which will not finish a single repository, and
its GraphQL API — which is what makes the commit walk affordable — refuses unauthenticated requests
outright.

## Why it is shaped this way

**Commit metadata, never commit contents.** Only author name, email and linked account are read per
commit; no source diffs are fetched.

**GraphQL, not REST `/commits`.** The same records at a fraction of the size, with several refs per
request — a repository that is 119 REST pages is single-digit requests here.

**Every branch and tag, not just the default one.** A contributor whose only commits sit on a side
branch is otherwise invisible.

**Addresses with no linked GitHub account are kept.** When GitHub does not recognise an address it
is the raw local `.gitconfig` value, and it can carry a machine hostname.

**`committer` is never read.** It is mostly `noreply@github.com`, one string shared by every GitHub
user who merges through the web UI — as a node, a permanent cross-project hub.

**`?author=<login>` is not used.** It misses commits made under a *previous* username's relay
address, which are the most valuable ones in the set.

**Relay addresses do not become email nodes**, but their `{digits}+` prefix is kept as the account's
numeric id, which survives a rename — and a relay address spelling a *different* login is recorded
as a former username that `resolves_to` the current account.

**Gist file names are properties, not nodes.** Generic names such as `gistfile1.txt` recur across
unrelated owners and would fuse them into one entity.

**Untouched forks are left out.** A fork nobody pushed to says nothing about its owner. The owners
that remain are often people the upstream scan cannot see, since work in a fork stays there unless a
pull request lands.

**Activity hours are fields, not a node.** A timezone node such as `UTC+9` would merge every subject
in that zone. Automation produces the *tightest* distributions of all, so read a sharp result as a
scheduler until something else says otherwise.

**Junk in the selection costs nothing.** Nodes a plugin cannot use are dropped *before* any request,
so "select everything and run" is safe. Only `github.com` and `www.github.com` URLs count, and an
organisation is only queried when a github.com URL says it is one — its name alone is not evidence.

**An oversized run is refused before it starts.** Commit Identities sums the `commit_count` that
Account Repositories records on each repository node and refuses a selection that cannot finish,
naming the total. When no count is known it refuses on the repository count instead and says that is
why.

**An empty result is a result.** A run that could not be carried out — no token, or nothing selected
that the plugin can act on — fails with an error. A run that WAS carried out and found nothing
succeeds: an account with no public activity in GitHub's window, an organisation with no public
members, an empty repository, an account GitHub says no longer exists, a search with no hits. The
summary says which one happened. One dead URL in a large selection does not discard everything
collected before it.

The token is checked before the selection is judged, so when both are wrong the message names the
one the analyst can fix.

## Code search is desktop-only

GitHub omits the CORS header from **authenticated code-search responses** specifically, so a browser
cannot read them. The desktop app can.

Two limits are GitHub's own: it searches **default branches of indexed repositories only**, and it
returns **at most 1,000 results** for any query however large the reported total. So scope the query
with `user:`, `org:` or `repo:` until the total is under a thousand — and read an empty result as
"not found in what was searched", never as "not on GitHub". The plugin reports the total alongside
what it retrieved.

## Build

```bash
npm install
npm run typecheck
npm run build        # bundles dist/pack.mjs, then regenerates plugins/github.manifest.json from it
GITHUB_TOKEN=<token> node test-plugin.mjs
```

The manifest is generated from the built bundle rather than maintained by hand, so the declared
scopes, parameters and versions cannot drift from the code they describe.

`test-plugin.mjs` runs the pack against the live API with an in-memory graph. It is not a unit test,
and it does not exercise the CORS behaviour that makes code search desktop-only.

## Licence

Apache-2.0
