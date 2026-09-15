# Jira Cloud Power (read-only)

Pull Jira Cloud ticket context into Kiro over the Jira REST API v3. It runs a
small local MCP server and uses your own Jira API token, so it consumes **no
Rovo credits** - just your normal Jira subscription.

## What it can do

**Strictly read-only.** It performs HTTP GET requests only and has no ability to
create, update, transition, comment on, or delete anything in Jira.

| Tool | What it does |
|---|---|
| `get_issue` | Fetch one issue by key (e.g. `PROJ-123`) and save it to `.jira/<KEY>/` in your workspace - details, comments and all attachments (see below). Returns the summary plus where it was saved. |
| `search_issues` | Search issues with a JQL query. Returns a capped list; **does not save anything to disk**. |
| `get_issue_comments` | Fetch an issue's comments, newest first, as plain text. |
| `get_attachment` | Download a single attachment by id to `_downloads/` under the data folder; returns a clickable `file://` link plus metadata. |

## Fetched tickets are saved into your workspace

Whenever a ticket is fetched with `get_issue`, the power writes it into a
`.jira` folder in the workspace you have open, so it shows up in your file tree
(`search_issues` is discovery only and saves nothing):

```
<workspace>/.jira/
  .gitignore              # ignores everything here, so tickets are never committed
  <TICKET-ID>/
    <TICKET-ID>.md        # details, description and comments as Markdown
    attachments/          # every attachment on the ticket, downloaded
      <filename>
```

The Markdown captures the key fields (status, type, assignee, labels, dates),
the description, a linked list of the downloaded attachments, and the ticket's
comments (newest first). All attachments are downloaded automatically.
Re-fetching a ticket rewrites its folder with the latest details.

A `.gitignore` is created inside `.jira` on first use so ticket data stays local
and is never committed.

### How the workspace is detected

A power's MCP server is launched with its working directory set to the plugin
root and receives no workspace path, so the power reads Kiro's own window state
file to find the folder you have open. Two consequences worth knowing:

- If **several** workspace windows are open, the power cannot tell which one the
  request came from. It uses the active window, or otherwise the most recently
  opened folder, and reports `locationAssumed: true` with the reason so you can
  see the assumption it made.
- If the workspace cannot be determined at all, the ticket is saved under the
  power's data folder (`~/.kiro/powers/data/kiro-power-jira-cloud/`) instead, and
  the response says so. Nothing is lost.

Detection relies on Kiro's internal window state file rather than a documented
API, so a future Kiro change could break it - in which case saving falls back to
the data folder as above.

## Prerequisites

- **Node.js 18+** (`node --version`). Node 22+ is recommended - see
  [corporate networks](#connection-fails-with-a-certificate-error-corporate-networks).
- A Jira Cloud account with access to the projects you want to read.

The power ships a prebuilt, self-contained server bundle
(`server/dist/index.js`), so there is **no `npm install`** and no dependencies to
fetch - it runs as soon as the power is installed.

## Setup

### 1. Let the server create your config file

Just start the power. On first run the server **creates an empty config file
automatically** at:

```
~/.kiro/powers/data/kiro-power-jira-cloud/config.json
```

and reports it:

```
Created a new config file at C:\Users\you\.kiro\powers\data\kiro-power-jira-cloud\config.json.
Open it and fill in:
  baseUrl  - your Jira site, e.g. https://your-site.atlassian.net
  email    - your Atlassian account email
  apiToken - create one at https://id.atlassian.com/manage-profile/security/api-tokens
Then reconnect the jira-cloud server.
```

### 2. Fill in your three values

Open that file and complete it:

```json
{
  "baseUrl": "https://your-site.atlassian.net",
  "email": "you@example.com",
  "apiToken": "your-api-token"
}
```

Create the token at
[id.atlassian.com API tokens](https://id.atlassian.com/manage-profile/security/api-tokens).

### 3. Reconnect

Reconnect the `jira-cloud` server in Kiro's **MCP Servers** panel (or restart
Kiro). The four tools become available.

## Where the config file lives

There is exactly one location, always:

```
~/.kiro/powers/data/kiro-power-jira-cloud/config.json
```

On Windows that is `C:\Users\<you>\.kiro\powers\data\kiro-power-jira-cloud\config.json`.

This is the only file the power reads or writes. There are no fallback
locations and no environment-variable alternatives, so there is never any
question about which file is in use.

It sits **outside** the power directory on purpose:

- The **installed** power folder is deleted and recopied on every update, which
  would wipe your credentials.
- The **source** power folder is what gets published, so a config file there
  would ship personal data to everyone who installs the power.

## Verifying it works

1. Open Kiro's **MCP Servers** panel - `jira-cloud` should be connected and list
   `get_issue`, `search_issues`, `get_issue_comments`, `get_attachment`.
2. Ask Kiro to fetch a known issue, e.g. "get Jira issue PROJ-123".
3. Ask Kiro to run a JQL search, e.g. "search Jira for open issues in PROJ".

If the server reports missing values, re-check the config file path from the
error message and that all three fields are filled in.

## Troubleshooting

### Connection fails with a certificate error (corporate networks)

If the server connects but Jira calls fail with `SELF_SIGNED_CERT_IN_CHAIN`,
your network performs TLS inspection: it re-signs HTTPS traffic with an internal
root CA. That CA is trusted by the OS, but Node ships its own CA list and
ignores the OS trust store by default.

The server handles this: on startup it merges the OS certificate store with
Node's bundled CAs (see `server/src/trust-system-ca.js`), with full certificate
validation left on. It is a no-op on networks without an inspecting proxy.

This runtime CA merge needs **Node 22+**. On older Node, either upgrade, or set
one of these before launching Kiro:

- `NODE_OPTIONS=--use-system-ca` - read the OS trust store, or
- `NODE_EXTRA_CA_CERTS=/path/to/corporate-root-ca.pem` - point at the exported CA.

Do **not** use `NODE_TLS_REJECT_UNAUTHORIZED=0` - it disables certificate
validation entirely.

### Seeing the real error

Kiro shows a short message on failure. To see the underlying cause, run the
bundled server directly:

```bash
cd server
node dist/index.js
```

A clean start prints `[jira-cloud] read-only MCP server started`. A
configuration problem exits immediately with a message naming the file and the
missing fields.

## Security notes

- The token grants your Jira permissions - this Power can read only what your
  account can already see.
- The token lives in your own config file, outside the power directory. Nothing
  personal is stored in the power itself, so the published package contains no
  credentials.
- The server is GET-only by construction; there is no code path that writes to
  Jira.
- Fetched tickets and their attachments are saved under `.jira/` in your
  workspace (git-ignored). Delete that folder any time; it is just local cache.

## Building from source (maintainers)

The power ships the prebuilt bundle at `server/dist/index.js`, so end users need
nothing extra. If you change anything under `server/src/`, rebuild the bundle
before committing:

```bash
cd server
npm install   # one-time, installs build-time dependencies
npm run build # regenerates server/dist/index.js
```

The build uses esbuild to produce a single self-contained ESM file. Runtime
dependencies are bundled in, which is why they live under `devDependencies` and
`node_modules` is not shipped.
