// Minimal read-only Jira Cloud REST API v3 client.
//
// This module ONLY performs HTTP GET requests. It intentionally exposes no
// method capable of creating, updating, transitioning, or deleting Jira data.
// Keeping the surface GET-only is the read-only guarantee for the whole Power.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Where the credentials file lives.
//
// This is the single, fixed location the power reads and writes - the power's
// data directory under the user's Kiro home. There are no alternative paths and
// no fallbacks, so there is exactly one file to fill in and no ambiguity about
// which one is in use.
//
// It sits outside the power directory on purpose: the installed power folder is
// deleted and recopied on every update, which would destroy the credentials,
// and the source folder is what gets published, which would leak them.
export const CONFIG_DIR = join(
  homedir(),
  ".kiro",
  "powers",
  "data",
  "kiro-power-jira-cloud"
);
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const CONFIG_TEMPLATE = {
  baseUrl: "",
  email: "",
  apiToken: "",
};

/**
 * Writes the empty config template if no config file exists yet, so the user
 * has a file to fill in rather than having to create one from scratch.
 *
 * @returns {boolean} true if a new template was created
 */
export function ensureConfigFile() {
  if (existsSync(CONFIG_PATH)) return false;
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG_TEMPLATE, null, 2) + "\n", "utf8");
  return true;
}

/** Reads and parses the per-user config file, tolerating an absent file. */
function readConfigFile() {
  if (!existsSync(CONFIG_PATH)) return {};
  let raw;
  try {
    raw = readFileSync(CONFIG_PATH, "utf8");
  } catch (err) {
    throw new Error(`Could not read config file ${CONFIG_PATH}: ${err.message}`);
  }
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new Error(
      `Config file ${CONFIG_PATH} is not valid JSON. Expected keys: baseUrl, email, apiToken.`
    );
  }
}

/**
 * Resolves and validates the Jira connection configuration.
 *
 * The config file at CONFIG_PATH is the only source. If it does not exist, an
 * empty template is created there and a descriptive error thrown naming the
 * file, so there is exactly one place for the user to fill in.
 *
 * @returns {{ baseUrl: string, email: string, apiToken: string }}
 */
export function readConfig() {
  const created = ensureConfigFile();
  const file = readConfigFile();

  // Ignore unsubstituted "${VAR}" placeholders, in case a value was pasted in
  // from a config template rather than filled with a real value.
  const clean = (value) => {
    const str = (value ?? "").toString().trim();
    return str.startsWith("${") ? "" : str;
  };

  const rawBaseUrl = clean(file.baseUrl);
  const email = clean(file.email);
  const apiToken = clean(file.apiToken);

  const missing = [];
  if (!rawBaseUrl) missing.push("baseUrl");
  if (!email) missing.push("email");
  if (!apiToken) missing.push("apiToken");

  if (missing.length > 0) {
    const lead = created
      ? `Created a new config file at ${CONFIG_PATH}.`
      : `Config file ${CONFIG_PATH} is missing value(s): ${missing.join(", ")}.`;
    throw new Error(
      `${lead} Open it and fill in:\n` +
        `  baseUrl  - your Jira site, e.g. https://your-site.atlassian.net\n` +
        `  email    - your Atlassian account email\n` +
        `  apiToken - create one at https://id.atlassian.com/manage-profile/security/api-tokens\n` +
        `Then reconnect the jira-cloud server.`
    );
  }

  // Normalise the base URL: require https so endpoint concatenation is
  // predictable and credentials are never sent in the clear.
  let baseUrl;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new Error(`baseUrl is not a valid URL: "${rawBaseUrl}" (in ${CONFIG_PATH})`);
  }
  if (baseUrl.protocol !== "https:") {
    throw new Error(`baseUrl must use https, got "${baseUrl.protocol}" (in ${CONFIG_PATH})`);
  }

  return {
    baseUrl: baseUrl.origin,
    email,
    apiToken,
  };
}

/**
 * Read-only Jira Cloud client. Every method issues an authenticated GET.
 */
export class JiraClient {
  constructor(config) {
    this.baseUrl = config.baseUrl;
    this.authHeader =
      "Basic " +
      Buffer.from(`${config.email}:${config.apiToken}`, "utf8").toString("base64");
  }

  /**
   * Issues an authenticated GET against a Jira REST path and returns parsed JSON.
   * Centralised so auth, headers, and error handling stay consistent and GET-only.
   *
   * @param {string} path e.g. "/rest/api/3/issue/PROJ-1"
   * @param {Record<string, string|number>} [query]
   */
  async get(path, query) {
    const url = new URL(path, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
        },
      });
    } catch (cause) {
      throw new Error(`Network error calling Jira (${url.pathname}): ${cause.message}`);
    }

    const bodyText = await response.text();

    if (!response.ok) {
      // Surface Jira's own error text but keep it bounded so a huge HTML error
      // page cannot flood the model context.
      const snippet = bodyText.slice(0, 500);
      throw new Error(
        `Jira returned ${response.status} ${response.statusText} for ${url.pathname}: ${snippet}`
      );
    }

    if (!bodyText) return {};
    try {
      return JSON.parse(bodyText);
    } catch {
      throw new Error(`Jira returned a non-JSON response for ${url.pathname}`);
    }
  }

  /**
   * GET /rest/api/3/issue/{key}
   * @param {string} issueKey e.g. "PROJ-123"
   */
  async getIssue(issueKey) {
    const path = `/rest/api/3/issue/${encodeURIComponent(issueKey)}`;
    return this.get(path, { fields: "summary,status,assignee,reporter,issuetype,priority,description,created,updated,labels,attachment" });
  }

  /**
   * GET /rest/api/3/search/jql
   * Searches issues with a JQL query. Uses the current search endpoint
   * (the older /rest/api/3/search has been deprecated by Atlassian).
   *
   * @param {string} jql a JQL query string
   * @param {number} maxResults capped by the caller
   */
  async searchIssues(jql, maxResults) {
    return this.get("/rest/api/3/search/jql", {
      jql,
      maxResults,
      fields: "summary,status,assignee,issuetype,priority,updated",
    });
  }

  /**
   * GET /rest/api/3/issue/{key}/comment
   * @param {string} issueKey e.g. "PROJ-123"
   * @param {number} maxResults capped by the caller
   */
  async getIssueComments(issueKey, maxResults) {
    const path = `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`;
    // orderBy=-created returns newest first, which is the useful default for context.
    return this.get(path, { maxResults, orderBy: "-created" });
  }

  /**
   * GET /rest/api/3/attachment/content/{id}
   * Downloads the raw bytes of an attachment. Jira redirects this to media
   * storage; fetch follows the redirect automatically. Returns the binary
   * content plus the content-type reported by the server.
   *
   * Still GET-only - this reads an existing attachment, it cannot upload.
   *
   * @param {string} attachmentId numeric attachment id (from getIssue's attachments)
   * @returns {Promise<{ bytes: Buffer, contentType: string }>}
   */
  async getAttachmentContent(attachmentId) {
    const url = new URL(
      `/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}`,
      this.baseUrl
    );

    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { Authorization: this.authHeader },
      });
    } catch (cause) {
      throw new Error(`Network error downloading attachment ${attachmentId}: ${cause.message}`);
    }

    if (!response.ok) {
      const snippet = (await response.text()).slice(0, 500);
      throw new Error(
        `Jira returned ${response.status} ${response.statusText} downloading attachment ${attachmentId}: ${snippet}`
      );
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    return { bytes, contentType };
  }
}
