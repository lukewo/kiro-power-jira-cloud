// Persists fetched tickets so they are visible in the project you are working in.
//
// Layout, inside the detected workspace folder:
//   <workspace>/.jira/
//     .gitignore              - ignores everything here, so tickets are never committed
//     <TICKET-ID>/
//       <TICKET-ID>.md        - ticket details and comments
//       attachments/          - every attachment on the ticket, downloaded
//         <filename>
//
// If the workspace cannot be determined, the same structure is written under the
// power's own data directory instead, so a fetch never silently loses data.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_DIR } from "./jira-client.js";
import { summariseIssue, summariseComment } from "./format.js";
import { detectWorkspace } from "./workspace.js";

// How many comments to pull into the saved Markdown.
const COMMENT_LIMIT = 50;

// Maps common content types to a file extension, used when an attachment has no
// usable filename so the saved file still opens in the right viewer.
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

/** Makes a string safe to use as a file or folder name on Windows and POSIX. */
function safeName(name, fallback) {
  const cleaned = (name ?? "").toString().trim().replace(/[^\w.\- ]/g, "_").trim();
  return cleaned || fallback;
}

/**
 * Resolves the root the ticket folders live under, preferring the open
 * workspace and falling back to the power's data directory.
 */
function resolveTicketRoot() {
  const ws = detectWorkspace();
  if (ws.path) {
    return {
      root: join(ws.path, ".jira"),
      inWorkspace: true,
      workspace: ws.path,
      assumed: ws.assumed,
      reason: ws.reason,
    };
  }
  return {
    root: CONFIG_DIR,
    inWorkspace: false,
    workspace: null,
    assumed: false,
    reason: `${ws.reason}; saved to the power data folder instead`,
  };
}

/**
 * Ensures a .gitignore inside the .jira folder so ticket data is never
 * committed. Written once; an existing file is left untouched.
 */
function ensureGitignore(root) {
  const path = join(root, ".gitignore");
  if (existsSync(path)) return;
  const body =
    "# Jira ticket data fetched by the jira-cloud Kiro power.\n" +
    "# Local working context - not intended to be committed.\n" +
    "*\n" +
    "!.gitignore\n";
  writeFileSync(path, body, "utf8");
}

/** Renders the ticket to Markdown, including comments. */
function renderIssueMarkdown(summary, downloaded, comments) {
  const lines = [];
  lines.push(`# ${summary.key} - ${summary.summary ?? "(no summary)"}`);
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Status | ${summary.status ?? ""} |`);
  lines.push(`| Type | ${summary.type ?? ""} |`);
  lines.push(`| Priority | ${summary.priority ?? ""} |`);
  lines.push(`| Assignee | ${summary.assignee ?? ""} |`);
  lines.push(`| Reporter | ${summary.reporter ?? ""} |`);
  lines.push(`| Labels | ${(summary.labels ?? []).join(", ")} |`);
  lines.push(`| Created | ${summary.created ?? ""} |`);
  lines.push(`| Updated | ${summary.updated ?? ""} |`);
  lines.push("");
  lines.push("## Description");
  lines.push("");
  lines.push(summary.description?.trim() ? summary.description : "_(no description)_");
  lines.push("");

  lines.push("## Attachments");
  lines.push("");
  if (!summary.attachments || summary.attachments.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const a of summary.attachments) {
      const local = downloaded.get(a.id);
      const label = a.filename ?? `attachment-${a.id}`;
      const meta = `${a.mimeType ?? "?"}, ${a.size ?? "?"} bytes`;
      lines.push(
        local
          ? `- [${label}](attachments/${encodeURIComponent(local)}) (${meta})`
          : `- ${label} (${meta}) - download failed`
      );
    }
  }
  lines.push("");

  lines.push("## Comments");
  lines.push("");
  if (!comments || comments.length === 0) {
    lines.push("_(none)_");
  } else {
    lines.push(`${comments.length} comment(s), newest first.`);
    lines.push("");
    for (const c of comments) {
      lines.push(`### ${c.author ?? "Unknown"} - ${c.created ?? ""}`);
      lines.push("");
      lines.push(c.body?.trim() ? c.body : "_(empty)_");
      lines.push("");
    }
  }

  lines.push(`_Saved ${new Date().toISOString()} by the jira-cloud power._`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Writes a fetched issue to disk: creates <root>/<ID>/, downloads every
 * attachment into <ID>/attachments/, fetches the issue's comments, and writes
 * <ID>.md containing the details, attachment links and comments.
 *
 * @param {object} rawIssue the raw Jira issue (from client.getIssue)
 * @param {import("./jira-client.js").JiraClient} client used for attachments and comments
 */
export async function saveTicket(rawIssue, client) {
  const summary = summariseIssue(rawIssue);
  const target = resolveTicketRoot();
  const key = safeName(summary.key, "unknown-ticket");

  const ticketDir = join(target.root, key);
  const attachmentsDir = join(ticketDir, "attachments");
  mkdirSync(attachmentsDir, { recursive: true });

  // Only the workspace .jira folder needs ignoring; the data dir is outside any repo.
  if (target.inWorkspace) ensureGitignore(target.root);

  // Download every attachment on the ticket.
  const downloaded = new Map(); // attachment id -> saved filename
  const attachmentErrors = [];
  const usedNames = new Set();

  for (const att of summary.attachments ?? []) {
    try {
      const { bytes, contentType } = await client.getAttachmentContent(att.id);
      let name = safeName(att.filename, `attachment-${att.id}${extensionForContentType(contentType)}`);
      if (usedNames.has(name)) {
        const dot = name.lastIndexOf(".");
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : "";
        name = `${stem}-${att.id}${ext}`;
      }
      usedNames.add(name);
      writeFileSync(join(attachmentsDir, name), bytes);
      downloaded.set(att.id, name);
    } catch (err) {
      attachmentErrors.push(`${att.filename ?? att.id}: ${err.message}`);
    }
  }

  // Pull the comments so the saved document is self-contained.
  let comments = [];
  let commentError = null;
  try {
    const result = await client.getIssueComments(summary.key, COMMENT_LIMIT);
    comments = (Array.isArray(result.comments) ? result.comments : []).map(summariseComment);
  } catch (err) {
    commentError = err.message;
  }

  const markdownPath = join(ticketDir, `${key}.md`);
  writeFileSync(markdownPath, renderIssueMarkdown(summary, downloaded, comments), "utf8");

  return {
    ticketDir,
    markdownPath,
    attachmentsDir,
    attachmentsSaved: downloaded.size,
    attachmentErrors,
    commentsSaved: comments.length,
    commentError,
    savedInWorkspace: target.inWorkspace,
    workspace: target.workspace,
    locationAssumed: target.assumed,
    locationReason: target.reason,
  };
}
