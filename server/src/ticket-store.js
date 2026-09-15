// Persists fetched tickets to the power's data folder.
//
// Layout, under the data dir (CONFIG_DIR):
//   <CONFIG_DIR>/
//     <TICKET-ID>/
//       <TICKET-ID>.md        - human-readable ticket details
//       attachments/          - every attachment on the ticket, downloaded
//         <filename>
//
// Every time a ticket is fetched, its folder is (re)written so the Markdown and
// attachments reflect the latest pull.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_DIR } from "./jira-client.js";
import { summariseIssue } from "./format.js";

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

/** Renders a fetched issue to Markdown for the ticket's <ID>.md file. */
function renderIssueMarkdown(summary, downloaded) {
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
      if (local) {
        lines.push(`- [${label}](attachments/${encodeURIComponent(local)}) (${a.mimeType ?? "?"}, ${a.size ?? "?"} bytes)`);
      } else {
        lines.push(`- ${label} (${a.mimeType ?? "?"}, ${a.size ?? "?"} bytes) - download failed`);
      }
    }
  }
  lines.push("");
  lines.push(`_Saved ${new Date().toISOString()} by the jira-cloud power._`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Writes a fetched issue to disk: creates <CONFIG_DIR>/<ID>/, downloads every
 * attachment into <ID>/attachments/, and writes <ID>.md.
 *
 * @param {object} rawIssue the raw Jira issue (from client.getIssue)
 * @param {import("./jira-client.js").JiraClient} client used to download attachments
 * @returns {Promise<{ ticketDir: string, markdownPath: string, attachmentsDir: string, attachmentsSaved: number, attachmentErrors: string[] }>}
 */
export async function saveTicket(rawIssue, client) {
  const summary = summariseIssue(rawIssue);
  const ticketDir = join(CONFIG_DIR, safeName(summary.key, "unknown-ticket"));
  const attachmentsDir = join(ticketDir, "attachments");
  mkdirSync(attachmentsDir, { recursive: true });

  const downloaded = new Map(); // attachment id -> saved filename
  const attachmentErrors = [];
  const usedNames = new Set();

  for (const att of summary.attachments ?? []) {
    try {
      const { bytes, contentType } = await client.getAttachmentContent(att.id);
      let name = safeName(att.filename, `attachment-${att.id}${extensionForContentType(contentType)}`);
      // Avoid collisions if two attachments share a filename.
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

  const markdownPath = join(ticketDir, `${safeName(summary.key, "unknown-ticket")}.md`);
  writeFileSync(markdownPath, renderIssueMarkdown(summary, downloaded), "utf8");

  return {
    ticketDir,
    markdownPath,
    attachmentsDir,
    attachmentsSaved: downloaded.size,
    attachmentErrors,
  };
}
