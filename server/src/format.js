// Helpers that trim Jira's verbose REST payloads into compact, context-friendly
// shapes. Jira descriptions/comments come back as Atlassian Document Format
// (ADF), a nested node tree; we flatten that to plain text.

/**
 * Recursively extracts plain text from an Atlassian Document Format node tree.
 * Unknown node types are traversed for their children so no text is lost.
 *
 * @param {any} node
 * @returns {string}
 */
export function adfToText(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;

  let out = "";
  if (typeof node.text === "string") {
    out += node.text;
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      out += adfToText(child);
    }
    // Block-level nodes should read as separate lines.
    if (["paragraph", "heading", "listItem", "blockquote", "codeBlock"].includes(node.type)) {
      out += "\n";
    }
  }
  return out;
}

/** Trims and collapses excessive blank lines from flattened ADF text. */
export function tidyText(text, maxLength = 4000) {
  const cleaned = (text ?? "")
    .replace(/\r/g, "")
    // Normalise common non-ASCII punctuation to plain ASCII so the output stays
    // clean UTF-8 without stray smart-quote / dash / nbsp artifacts.
    .replace(/\u00a0/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) + "\n...[truncated]" : cleaned;
}

/** Shapes a raw Jira issue into a compact summary object. */
export function summariseIssue(issue) {
  const f = issue.fields ?? {};
  return {
    key: issue.key,
    summary: f.summary ?? null,
    status: f.status?.name ?? null,
    type: f.issuetype?.name ?? null,
    priority: f.priority?.name ?? null,
    assignee: f.assignee?.displayName ?? null,
    reporter: f.reporter?.displayName ?? null,
    labels: Array.isArray(f.labels) ? f.labels : [],
    created: f.created ?? null,
    updated: f.updated ?? null,
    description: tidyText(adfToText(f.description)),
    attachments: Array.isArray(f.attachment) ? f.attachment.map(summariseAttachment) : [],
  };
}

/** Shapes a single Jira attachment into a compact object with its id for download. */
export function summariseAttachment(attachment) {
  return {
    id: attachment.id,
    filename: attachment.filename ?? null,
    mimeType: attachment.mimeType ?? null,
    size: attachment.size ?? null,
    created: attachment.created ?? null,
    author: attachment.author?.displayName ?? null,
  };
}

/** Shapes a single Jira comment into a compact object. */
export function summariseComment(comment) {
  return {
    id: comment.id,
    author: comment.author?.displayName ?? null,
    created: comment.created ?? null,
    updated: comment.updated ?? null,
    body: tidyText(adfToText(comment.body)),
  };
}
