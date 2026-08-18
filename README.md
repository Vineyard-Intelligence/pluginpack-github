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
enough — everything here reads public data. Every plugin requires it, and a missing token is raised
as an error rather than returned as an empty result, because on this host an empty result is
reported as a successful run that found nothing.

Without a token GitHub allows 60 requests an hour, which will not finish a single repository, and
its GraphQL API — which is what makes the commit walk affordable — refuses unauthenticated requests
outright.

## Why it is shaped this way

Each of these was measured against the live API, and several of them contradict the obvious
approach.

**Commit metadata, never commit contents.** The history connection returns author name, email and
linked account per commit. Fetching an individual commit instead would return `files[].patch` — the
source diff — for data already in hand.

**GraphQL, not REST `/commits`.** The same records, but naming four fields costs ~190 bytes per
commit against REST's ~4.6 KB, and several refs fit in one request as aliases. A repository that is
119 REST pages is single-digit requests here. Checked against a `--filter=blob:none` bare clone of
six repositories: identical author-email sets.

**Every branch and tag, not just the default one.** `/commits` stops at HEAD, so a contributor whose
only commits sit on a side branch is invisible to it.

**Addresses with no linked GitHub account are kept.** When `author.user` is null, GitHub does not
recognise the address — which is precisely what makes it interesting: it is the raw local
`.gitconfig` value, and it can carry a machine hostname. On one repository, 9 of 35 commits were
exactly this, and filtering on the linked login would have dropped all of them.

**`committer` is never read.** On a 100-commit sample of a busy repository, 52 commits carried
`noreply@github.com` — one string shared by every GitHub user who merges through the web UI. As a
node it is a permanent cross-case hub.

**`?author=<login>` is not used.** Measured: it returned 36 of 52 commits across one account's
repositories. The missing 16 were all made under a *previous* username's relay address — which is
the single most valuable thing in the set.

**Relay addresses do not become email nodes**, but their `{digits}+` prefix is kept as the account's
numeric id, which survives a rename — and a relay address spelling a *different* login is recorded
as a former username that `resolves_to` the current account.

**Gist file names are properties, not nodes.** Across seven accounts, 542 gist files carried 392
distinct names, and `gistfile1.txt` alone appeared 95 times across six owners. As nodes, those would
fuse six unrelated subjects into one entity.

**Untouched forks are left out.** Only 42% of a busy repository's forks had been pushed to after
creation. A fork button press says nothing about the person who pressed it. Of the fork owners that
survive the filter, only 7.8% also appear in the upstream commit history — work done in a fork stays
there unless a pull request lands, so these are people the upstream scan structurally cannot see.

**Activity hours are fields, not a node.** A timezone node would be labelled by its name, so one
`UTC+9` would merge every Korean, Japanese and eastern-Russian subject in the graph. And automation
produces the *tightest* distributions of all, so read a sharp result as a scheduler until something
else says otherwise.

**Junk in the selection costs nothing.** The host does not filter a run's selection by the plugin's
declared `consumes` — neither the UI nor the agent — so "select everything and run" arrives holding
every node in the project. Nodes that are not what a plugin needs are dropped *before* any request,
and the host check is exact (`github.com` and `www.github.com` only). That precision matters more
than it looks: a looser host pattern also matched `gist.github.com/<user>/<id>`, and the Gists plugin
in this pack produces those by the dozen — so a whole-project run used to query GitHub for
repositories that never existed, off nodes the pack had created itself. An organisation is likewise
only queried when a github.com URL says it is one; its name alone is not evidence, and acting on a
name would attach a coincidentally-identical GitHub org's members to an unrelated subject.

**An oversized run is refused before it starts.** Commit Identities sums the `commit_count` that
Account Repositories records on each repository node and refuses a selection that cannot finish,
naming the total. When no count is known it refuses on the repository count instead and says that is
why — a run whose size cannot be established should not begin silently.

## Code search is desktop-only

GitHub answers `access-control-allow-origin: *` on every endpoint this pack uses — including the
same search API for repositories and users — but omits it from **authenticated code-search
responses** specifically. Measured both ways: the keyless 401 carries the header, the authenticated
200 does not. So in a browser the response is discarded before its status is visible, even though
the server did send the data.

The desktop shell fixes exactly this, and it does it **through the manifest rather than through any
code in the plugin**. The renderer collects every installed plugin's declared `network` endpoints,
publishes their origins to the main process, and the shell then strips `Origin` on the way out and
writes the CORS headers on the way back — for those origins only, for as long as the project that
declared them is open. The request GitHub sees is an ordinary API call from a script, which is why
this works at all.

Two limits are GitHub's own and no shell fixes them: it searches **default branches of indexed
repositories only**, and it returns **at most 1,000 results** for any query however large the
reported total. So scope the query with `user:`, `org:` or `repo:` until the total is under a
thousand — and read an empty result as "not found in what was searched", never as "not on GitHub".
That distinction is the whole reason the plugin reports the total alongside what it retrieved: on
this host an empty return is painted as a successful run, and the query people most often bring here
is "did my key leak".

## Build

```bash
npm install
npm run typecheck
npm run build        # bundles dist/pack.mjs, then regenerates plugins/github.manifest.json from it
GITHUB_TOKEN=<token> node test-plugin.mjs
```

The manifest is generated from the built bundle rather than maintained by hand, so the declared
scopes, parameters and versions cannot drift from the code they describe.

`test-plugin.mjs` runs the pack against the live API with an in-memory graph. It is not a unit test:
every failure mode worth guarding against here is a property of the real responses and disappears
the moment they are mocked. It was also worth writing — the first run caught a bot filter that
deleted a sole maintainer's real email address, because in a single-author repository the author is,
by definition, most of the commits.

One thing it cannot show: Node's fetch has no same-origin policy, so the code-search step exercises
the plugin and the API contract but not the CORS behaviour that makes it desktop-only. That part
rests on reading the shell and on the header measurement above.

## Licence

Apache-2.0
