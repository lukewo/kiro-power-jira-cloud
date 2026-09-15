#!/usr/bin/env node
// Read-only Jira Cloud MCP server (stdio transport).
//
// Exposes read-only tools over the Jira Cloud REST API v3. It performs GET
// requests only and has no capability to create, update, transition, comment
// on, or delete anything in Jira.
//
// Credentials are read from a single config file at
// ~/.kiro/powers/data/kiro-power-jira-cloud/config.json (baseUrl, email,
// apiToken). It is created as an empty template on first run if missing, so no
// credentials ever live inside this power directory.

// Trust the OS certificate store before any HTTPS request is made. This lets
// the server work behind corporate TLS-inspection proxies. Must be first.
import "./trust-system-ca.js";

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { readConfig, JiraClient, CONFIG_DIR } from "./jira-client.js";
import { summariseIssue, summariseComment } from "./format.js";
import { saveTicket } from "./ticket-store.js";

// Ad-hoc single-attachment downloads (via the get_attachment tool) land here,
// under the data dir - never inside the power folder, which is wiped on update.
const ATTACHMENTS_DIR = join(CONFIG_DIR, "_downloads");

// Maps common content types to a file extension, used only when the caller does
// not supply a filename, so the saved file still opens in the right viewer.
const CONTENT_TYPE_EXTENSIONS = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
};

function extensionForContentType(contentType) {
  const base = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return CONTENT_TYPE_EXTENSIONS[base] ?? "";
}

// Fail fast with a clear message if the credentials are not configured.
let client;
try {
  client = new JiraClient(readConfig());
} catch (err) {
  process.stderr.write(`[jira-cloud] ${err.message}\n`);
  process.exit(1);
}

const server = new McpServer({
  name: "jira-cloud",
  version: "1.0.0",
});

/** Wraps a tool handler so Jira/network errors surface as tool errors, not crashes. */
function toolResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function toolError(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

server.registerTool(
  "get_issue",
  {
    title: "Get Jira issue",
    description:
      "Fetch a single Jira issue by key (e.g. PROJ-123) and return a compact summary " +
      "including status, type, assignee, labels, and description. Read-only.",
    inputSchema: {
      issueKey: z
        .string()
        .min(1)
        .describe("The Jira issue key, e.g. PROJ-123"),
    },
  },
  async ({ issueKey }) => {
    try {
      const issue = await client.getIssue(issueKey.trim());
      const summary = summariseIssue(issue);
      // Persist the ticket: <data>/<ID>/<ID>.md plus <ID>/attachments/* with all
      // attachments downloaded.
      const saved = await saveTicket(issue, client);
      return toolResult({
        ...summary,
        saved: {
          folder: saved.ticketDir,
          markdown: saved.markdownPath,
          attachmentsDir: saved.attachmentsDir,
          attachmentsSaved: saved.attachmentsSaved,
          attachmentErrors: saved.attachmentErrors,
        },
      });
    } catch (err) {
      return toolError(`get_issue failed: ${err.message}`);
    }
  }
);

server.registerTool(
  "search_issues",
  {
    title: "Search Jira issues (JQL)",
    description:
      "Search Jira issues using a JQL query (e.g. \"project = PROJ AND status = 'In Progress'\"). " +
      "Returns a capped list of compact issue summaries. Read-only.",
    inputSchema: {
      jql: z.string().min(1).describe("A JQL query string"),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Maximum issues to return (1-50, default 25)"),
    },
  },
  async ({ jql, maxResults }) => {
    const cap = Math.min(maxResults ?? 25, 50);
    try {
      const result = await client.searchIssues(jql.trim(), cap);
      const issues = Array.isArray(result.issues) ? result.issues : [];

      // Persist every matched ticket. Search results are compact (no
      // description/attachments), so fetch full detail per hit before saving.
      const saved = [];
      const saveErrors = [];
      for (const hit of issues) {
        try {
          const full = await client.getIssue(hit.key);
          const s = await saveTicket(full, client);
          saved.push({ key: hit.key, folder: s.ticketDir, attachmentsSaved: s.attachmentsSaved });
        } catch (err) {
          saveErrors.push(`${hit.key}: ${err.message}`);
        }
      }

      return toolResult({
        // The /search/jql endpoint returns a page without a grand total; it
        // signals more results via nextPageToken rather than a total count.
        returned: issues.length,
        hasMore: Boolean(result.nextPageToken),
        issues: issues.map((issue) => {
          const f = issue.fields ?? {};
          return {
            key: issue.key,
            summary: f.summary ?? null,
            status: f.status?.name ?? null,
            type: f.issuetype?.name ?? null,
            priority: f.priority?.name ?? null,
            assignee: f.assignee?.displayName ?? null,
            updated: f.updated ?? null,
          };
        }),
        saved,
        saveErrors,
      });
    } catch (err) {
      return toolError(`search_issues failed: ${err.message}`);
    }
  }
);

server.registerTool(
  "get_issue_comments",
  {
    title: "Get Jira issue comments",
    description:
      "Fetch comments for a Jira issue by key (e.g. PROJ-123), newest first, as plain text. Read-only.",
    inputSchema: {
      issueKey: z.string().min(1).describe("The Jira issue key, e.g. PROJ-123"),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Maximum comments to return (1-50, default 20)"),
    },
  },
  async ({ issueKey, maxResults }) => {
    const cap = Math.min(maxResults ?? 20, 50);
    try {
      const result = await client.getIssueComments(issueKey.trim(), cap);
      const comments = Array.isArray(result.comments) ? result.comments : [];
      return toolResult({
        issueKey: issueKey.trim(),
        total: result.total ?? comments.length,
        returned: comments.length,
        comments: comments.map(summariseComment),
      });
    } catch (err) {
      return toolError(`get_issue_comments failed: ${err.message}`);
    }
  }
);

server.registerTool(
  "get_attachment",
  {
    title: "Get Jira attachment",
    description:
      "Download a Jira attachment by its numeric id (from get_issue's 'attachments' list). " +
      "The file is saved locally and a clickable file:// link plus metadata is returned. Read-only.",
    inputSchema: {
      attachmentId: z
        .string()
        .min(1)
        .describe("The numeric attachment id, e.g. 314720 (see get_issue attachments[].id)"),
      filename: z
        .string()
        .optional()
        .describe("Optional filename to save as (used for non-image types and as a hint)"),
    },
  },
  async ({ attachmentId, filename }) => {
    const id = attachmentId.trim();
    try {
      const { bytes, contentType } = await client.getAttachmentContent(id);

      // Always save to disk and return a clickable link. Inline image content
      // blocks are not reliably rendered by the chat client, so a file link the
      // user can open is the dependable way to actually view an attachment.
      mkdirSync(ATTACHMENTS_DIR, { recursive: true });
      // Prefer the caller-supplied name; otherwise fall back to a name derived
      // from the id and the content-type extension so the file opens correctly.
      const fallbackName = `attachment-${id}${extensionForContentType(contentType)}`;
      const safeName = (filename?.trim() || fallbackName).replace(/[^\w.\-]/g, "_");
      const outPath = join(ATTACHMENTS_DIR, safeName);
      writeFileSync(outPath, bytes);

      const fileUrl = pathToFileURL(outPath).href;

      return toolResult({
        attachmentId: id,
        contentType,
        size: bytes.length,
        savedTo: outPath,
        link: fileUrl,
        note: "Open the link to view the attachment.",
      });
    } catch (err) {
      return toolError(`get_attachment failed: ${err.message}`);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("[jira-cloud] read-only MCP server started\n");
