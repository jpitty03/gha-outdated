'use strict';

/**
 * Minimal GitHub API client for listing repository tags and selecting the
 * highest stable numeric version. Uses only the Node.js standard library.
 *
 * - Bounded pagination (`maxPages` pages of `perPage` tags).
 * - Per-repository caching so multiple refs cause one logical lookup.
 * - Finite request timeout and response-size guard.
 * - Descriptive User-Agent, GitHub JSON accept header, API-version header,
 *   and `Authorization: Bearer ...` when a token is provided. The token is
 *   never echoed in output or errors.
 */

const http = require('http');
const https = require('https');

const { parseVersion, compareVersions } = require('./versions');

const DEFAULT_BASE_URL = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'gha-outdated (https://github.com/jpitty03/gha-outdated)';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_PAGES = 3;
const DEFAULT_PER_PAGE = 100;
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 3;

/** Error describing a failed repository lookup with actionable diagnostics. */
class LookupError extends Error {
  constructor(repo, message) {
    super(`${repo}: ${message}`);
    this.name = 'LookupError';
    this.repo = repo;
  }
}

class GitHubClient {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl] API base URL (overridable for tests).
   * @param {string} [options.token] GitHub token for authenticated requests.
   * @param {number} [options.timeoutMs]
   * @param {number} [options.maxPages]
   * @param {number} [options.perPage]
   * @param {number} [options.maxBodyBytes]
   */
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.token = options.token || null;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.maxPages = options.maxPages || DEFAULT_MAX_PAGES;
    this.perPage = options.perPage || DEFAULT_PER_PAGE;
    this.maxBodyBytes = options.maxBodyBytes || DEFAULT_MAX_BODY_BYTES;
    this.cache = new Map();
  }

  /**
   * Resolve the highest stable numeric version tag for `owner/repo`.
   * Results (including failures) are cached per repository.
   *
   * @param {string} repo `owner/repo`
   * @returns {Promise<{ tag: string, version: object }|null>} `null` when the
   *   repository has no comparable stable numeric tags.
   */
  getLatestVersion(repo) {
    if (!this.cache.has(repo)) {
      this.cache.set(repo, this._lookup(repo));
    }
    return this.cache.get(repo);
  }

  async _lookup(repo) {
    let best = null;
    for (let page = 1; page <= this.maxPages; page += 1) {
      const tags = await this._fetchTagsPage(repo, page);
      for (const tag of tags) {
        if (!tag || typeof tag.name !== 'string') {
          continue;
        }
        const version = parseVersion(tag.name);
        if (!version) {
          continue; // prerelease, SHA-like, or custom tag: not comparable
        }
        if (!best || compareVersions(version, best.version) > 0) {
          best = { tag: tag.name, version };
        }
      }
      if (tags.length < this.perPage) {
        break;
      }
    }
    return best;
  }

  async _fetchTagsPage(repo, page) {
    const url = `${this.baseUrl}/repos/${repo}/tags?per_page=${this.perPage}&page=${page}`;
    const response = await this._request(repo, url);

    if (response.statusCode === 404) {
      throw new LookupError(repo, 'repository not found (404)');
    }
    if (response.statusCode === 403 || response.statusCode === 429) {
      const remaining = response.headers['x-ratelimit-remaining'];
      const reset = response.headers['x-ratelimit-reset'];
      let message = `GitHub API rate limit or access error (${response.statusCode}).`;
      if (remaining === '0') {
        message = 'GitHub API rate limit exceeded.';
        if (reset) {
          const resetDate = new Date(Number(reset) * 1000);
          if (!Number.isNaN(resetDate.getTime())) {
            message += ` Limit resets at ${resetDate.toISOString()}.`;
          }
        }
      }
      message += this.token
        ? ' The provided GITHUB_TOKEN was rejected or throttled.'
        : ' Set GITHUB_TOKEN to raise the unauthenticated limit (60 requests/hour).';
      throw new LookupError(repo, message);
    }
    if (response.statusCode !== 200) {
      throw new LookupError(
        repo,
        `unexpected GitHub API response (HTTP ${response.statusCode})`
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new LookupError(repo, 'invalid JSON in GitHub API response');
    }
    if (!Array.isArray(parsed)) {
      throw new LookupError(repo, 'unexpected GitHub API payload (expected an array of tags)');
    }
    return parsed;
  }

  _request(repo, url, redirects = 0) {
    return new Promise((resolve, reject) => {
      const headers = {
        'User-Agent': USER_AGENT,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
      };
      if (this.token) {
        headers.Authorization = `Bearer ${this.token}`;
      }

      const transport = url.startsWith('https:') ? https : http;
      const request = transport.get(url, { headers }, (response) => {
        const { statusCode } = response;
        if (
          statusCode >= 301 &&
          statusCode <= 308 &&
          response.headers.location
        ) {
          response.resume();
          if (redirects >= MAX_REDIRECTS) {
            reject(new LookupError(repo, 'too many redirects from GitHub API'));
            return;
          }
          const nextUrl = new URL(response.headers.location, url).toString();
          resolve(this._request(repo, nextUrl, redirects + 1));
          return;
        }

        let size = 0;
        const chunks = [];
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > this.maxBodyBytes) {
            request.destroy();
            reject(new LookupError(repo, 'GitHub API response exceeded size limit'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          resolve({
            statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        response.on('error', (error) => {
          reject(new LookupError(repo, `network error: ${error.message}`));
        });
      });

      request.setTimeout(this.timeoutMs, () => {
        request.destroy(
          new LookupError(repo, `request timed out after ${this.timeoutMs}ms`)
        );
      });
      request.on('error', (error) => {
        reject(
          error instanceof LookupError
            ? error
            : new LookupError(repo, `network error: ${error.message}`)
        );
      });
    });
  }
}

/**
 * Map `items` through async `worker` with at most `limit` in flight.
 * Rejections are surfaced per item as `{ error }` results by the caller's
 * worker; this helper itself never swallows errors.
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await worker(items[index], index);
      }
    }
  );
  await Promise.all(lanes);
  return results;
}

module.exports = {
  GitHubClient,
  LookupError,
  mapWithConcurrency,
  DEFAULT_BASE_URL,
  USER_AGENT,
  API_VERSION,
};
