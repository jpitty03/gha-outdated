'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { GitHubClient, LookupError, mapWithConcurrency } = require('../lib/github');

/**
 * Start a local HTTP server whose behavior is driven by `handler`.
 * Returns { baseUrl, requests, close }.
 */
function startServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({
      url: req.url,
      headers: req.headers,
    });
    handler(req, res, requests.length);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function jsonResponse(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

test('selects highest stable numeric tag, ignoring prereleases and floating aliases', async () => {
  const server = await startServer((req, res) => {
    jsonResponse(res, 200, [
      { name: 'v4' }, // floating alias
      { name: 'v4.1.2' },
      { name: 'v5.0.0-rc.1' }, // prerelease: ignored
      { name: 'v3.9.9' },
      { name: 'not-a-version' },
      { name: null },
    ]);
  });
  try {
    const client = new GitHubClient({ baseUrl: server.baseUrl });
    const latest = await client.getLatestVersion('actions/checkout');
    assert.equal(latest.tag, 'v4.1.2');
  } finally {
    await server.close();
  }
});

test('paginates while pages are full and stays within the page bound', async () => {
  const fullPage = Array.from({ length: 3 }, (_, i) => ({ name: `v1.0.${i}` }));
  const server = await startServer((req, res, count) => {
    if (count === 1) {
      jsonResponse(res, 200, fullPage);
    } else {
      jsonResponse(res, 200, [{ name: 'v2.0.0' }]);
    }
  });
  try {
    const client = new GitHubClient({
      baseUrl: server.baseUrl,
      perPage: 3,
      maxPages: 2,
    });
    const latest = await client.getLatestVersion('octo/repo');
    assert.equal(latest.tag, 'v2.0.0');
    assert.equal(server.requests.length, 2);
    assert.match(server.requests[0].url, /per_page=3&page=1/);
    assert.match(server.requests[1].url, /per_page=3&page=2/);
  } finally {
    await server.close();
  }
});

test('sends descriptive headers and bearer token; caches per repository', async () => {
  const server = await startServer((req, res) => {
    jsonResponse(res, 200, [{ name: 'v1.0.0' }]);
  });
  try {
    const client = new GitHubClient({
      baseUrl: server.baseUrl,
      token: 'test-token-123',
    });
    const first = await client.getLatestVersion('octo/repo');
    const second = await client.getLatestVersion('octo/repo');
    assert.equal(first.tag, 'v1.0.0');
    assert.equal(second.tag, 'v1.0.0');
    assert.equal(server.requests.length, 1, 'second lookup served from cache');

    const { headers } = server.requests[0];
    assert.match(headers['user-agent'], /gha-outdated/);
    assert.equal(headers.accept, 'application/vnd.github+json');
    assert.equal(headers['x-github-api-version'], '2022-11-28');
    assert.equal(headers.authorization, 'Bearer test-token-123');
  } finally {
    await server.close();
  }
});

test('omits authorization header without a token and returns null for no usable tags', async () => {
  const server = await startServer((req, res) => {
    jsonResponse(res, 200, [{ name: 'nightly' }, { name: 'latest' }]);
  });
  try {
    const client = new GitHubClient({ baseUrl: server.baseUrl });
    const latest = await client.getLatestVersion('octo/no-tags');
    assert.equal(latest, null);
    assert.equal(server.requests[0].headers.authorization, undefined);
  } finally {
    await server.close();
  }
});

test('404 raises a repository-not-found LookupError', async () => {
  const server = await startServer((req, res) => {
    jsonResponse(res, 404, { message: 'Not Found' });
  });
  try {
    const client = new GitHubClient({ baseUrl: server.baseUrl });
    await assert.rejects(
      client.getLatestVersion('octo/missing'),
      (error) => {
        assert.ok(error instanceof LookupError);
        assert.match(error.message, /octo\/missing/);
        assert.match(error.message, /not found \(404\)/);
        return true;
      }
    );
  } finally {
    await server.close();
  }
});

test('403 rate limit includes reset guidance and never prints the token', async () => {
  const server = await startServer((req, res) => {
    jsonResponse(
      res,
      403,
      { message: 'rate limited' },
      { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1767225600' }
    );
  });
  try {
    const client = new GitHubClient({
      baseUrl: server.baseUrl,
      token: 'super-secret-token',
    });
    await assert.rejects(client.getLatestVersion('octo/limited'), (error) => {
      assert.match(error.message, /rate limit exceeded/i);
      assert.match(error.message, /resets at/i);
      assert.ok(!error.message.includes('super-secret-token'));
      return true;
    });
  } finally {
    await server.close();
  }
});

test('403 without a token suggests setting GITHUB_TOKEN', async () => {
  const server = await startServer((req, res) => {
    jsonResponse(res, 403, {}, { 'x-ratelimit-remaining': '0' });
  });
  try {
    const client = new GitHubClient({ baseUrl: server.baseUrl });
    await assert.rejects(client.getLatestVersion('octo/limited'), (error) => {
      assert.match(error.message, /Set GITHUB_TOKEN/);
      return true;
    });
  } finally {
    await server.close();
  }
});

test('5xx and invalid payloads raise LookupErrors', async () => {
  const server = await startServer((req, res, count) => {
    if (count === 1) {
      jsonResponse(res, 500, { message: 'boom' });
    } else if (count === 2) {
      jsonResponse(res, 200, 'this is not json');
    } else {
      jsonResponse(res, 200, { not: 'an array' });
    }
  });
  try {
    const client = new GitHubClient({ baseUrl: server.baseUrl });
    await assert.rejects(client.getLatestVersion('octo/one'), /HTTP 500/);
    await assert.rejects(client.getLatestVersion('octo/two'), /invalid JSON/);
    await assert.rejects(client.getLatestVersion('octo/three'), /expected an array/);
  } finally {
    await server.close();
  }
});

test('requests time out after the configured interval', async () => {
  const server = await startServer(() => {
    // Never respond.
  });
  try {
    const client = new GitHubClient({ baseUrl: server.baseUrl, timeoutMs: 100 });
    await assert.rejects(client.getLatestVersion('octo/slow'), /timed out after 100ms/);
  } finally {
    await server.close();
  }
});

test('socket destruction surfaces as a network LookupError', async () => {
  const server = await startServer((req) => {
    req.socket.destroy();
  });
  try {
    const client = new GitHubClient({ baseUrl: server.baseUrl });
    await assert.rejects(client.getLatestVersion('octo/reset'), /network error/);
  } finally {
    await server.close();
  }
});

test('oversized responses are rejected by the size guard', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(`["${'x'.repeat(2048)}"]`);
  });
  try {
    const client = new GitHubClient({ baseUrl: server.baseUrl, maxBodyBytes: 1024 });
    await assert.rejects(client.getLatestVersion('octo/huge'), /size limit/);
  } finally {
    await server.close();
  }
});

test('redirects are followed up to a bounded depth', async () => {
  const server = await startServer((req, res) => {
    if (req.url.includes('/moved/')) {
      res.writeHead(302, { Location: req.url.replace('/moved/', '/octo/') });
      res.end();
    } else if (req.url.includes('/loop/')) {
      res.writeHead(302, { Location: req.url });
      res.end();
    } else {
      jsonResponse(res, 200, [{ name: 'v1.0.0' }]);
    }
  });
  try {
    const client = new GitHubClient({ baseUrl: server.baseUrl });
    const latest = await client.getLatestVersion('moved/repo');
    assert.equal(latest.tag, 'v1.0.0');
    await assert.rejects(client.getLatestVersion('loop/forever'), /too many redirects/);
  } finally {
    await server.close();
  }
});

test('mapWithConcurrency preserves order and honors the limit', async () => {
  let inFlight = 0;
  let peak = 0;
  const items = [1, 2, 3, 4, 5, 6];
  const results = await mapWithConcurrency(items, 2, async (item) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight -= 1;
    return item * 10;
  });
  assert.deepEqual(results, [10, 20, 30, 40, 50, 60]);
  assert.ok(peak <= 2, `peak concurrency ${peak} exceeded limit`);
});
