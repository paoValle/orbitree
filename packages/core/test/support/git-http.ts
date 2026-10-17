/**
 * A git HTTP server that wants a credential, for the one test that needs one.
 *
 * The product talks to remotes through git, so a test of "the token came from the helper and never
 * appeared anywhere" needs a remote that *refuses* without a token. A `file://` remote never asks, and
 * `git://` speaks a protocol with no credentials in it, so this is a real git HTTP transport: node's
 * HTTP server in front of `git http-backend`, which is the same program a forge runs, with Basic auth
 * required before the request reaches it.
 *
 * It lives in the tests and not in the product: `packages/core/src` may not import `node:http` (I7),
 * and a test may do what the product must not.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:http';

export interface GitHttpServer {
  /** `http://127.0.0.1:<port>` — the port is whatever the machine had free. */
  readonly url: string;
  /** How many requests arrived, so a test can tell a refusal from a transport that never spoke. */
  readonly requests: number;
  readonly close: () => Promise<void>;
}

/**
 * Serves the repositories under `root` over HTTP, requiring `someone:<token>`.
 *
 * `root` is the *directory* holding the repositories, as `GIT_PROJECT_ROOT` means it: the URL path is
 * the repository's own name, so `http://127.0.0.1:1234/remote.git` is `<root>/remote.git`.
 */
export async function startGitHttp(root: string, token: string): Promise<GitHttpServer> {
  const expected = `Basic ${Buffer.from(`someone:${token}`).toString('base64')}`;
  let requests = 0;

  const server = createServer((request, response) => {
    requests += 1;
    if ((request.headers.authorization ?? '') !== expected) {
      response.writeHead(401, {
        'www-authenticate': 'Basic realm="git"',
        'content-type': 'text/plain',
      });
      response.end('authentication required\n');
      return;
    }

    const [path = '', query = ''] = (request.url ?? '/').split('?');
    const backend: ChildProcess = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        // Every repository under the root is served, and this is the only authentication: the
        // helper's answer is what gets past it.
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: path,
        QUERY_STRING: query,
        REQUEST_METHOD: request.method ?? 'GET',
        CONTENT_TYPE: request.headers['content-type'] ?? '',
        CONTENT_LENGTH: String(request.headers['content-length'] ?? ''),
        REMOTE_USER: 'someone',
        GIT_PROTOCOL: String(request.headers['git-protocol'] ?? ''),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Both directions can fail while git is still deciding: an EPIPE on stdin is a request the
    // backend never read, and it must not take the test down with an unhandled 'error' event.
    request.pipe(backend.stdin as NodeJS.WritableStream);
    backend.stdin?.on('error', () => undefined);
    backend.stdout?.on('error', () => undefined);
    // A client that goes away mid-request (git does, after a refusal) is not this fixture's problem.
    request.on('error', () => undefined);

    const out: Buffer[] = [];
    let answered = false;
    let ended = false;
    /**
     * A CGI response is headers, a blank line, then the body — and the body can arrive in pieces, so
     * the split happens once and the rest is streamed after it.
     */
    const flush = (chunk: Buffer, final: boolean): void => {
      out.push(chunk);
      const whole = Buffer.concat(out);
      if (!answered) {
        const end = whole.indexOf('\r\n\r\n');
        const alternative = whole.indexOf('\n\n');
        const split = end === -1 ? alternative : end;
        if (split === -1) return;
        const header = whole.subarray(0, split).toString('utf8');
        const body = whole.subarray(split + (end === -1 ? 2 : 4));
        const status = /^Status:\s*(\d+)\s*([^\r\n]*)/m.exec(header);
        const headers: Record<string, string> = {};
        for (const line of header.split('\n')) {
          const colon = line.indexOf(':');
          if (colon === -1) continue;
          const name = line.slice(0, colon).trim().toLowerCase();
          const value = line.slice(colon + 1).trim();
          if (name !== 'status') headers[name] = value;
        }
        response.writeHead(status === null ? 200 : Number(status[1]), headers);
        answered = true;
        if (body.length > 0) response.write(body);
      } else {
        response.write(chunk);
      }
      if (final && !ended) {
        ended = true;
        // A backend that said nothing is a 502 rather than a request that hangs: the test's next
        // assertion is about what the product did, and it cannot do anything against a hang.
        if (!answered) {
          answered = true;
          response.writeHead(502);
        }
        response.end();
      }
    };

    backend.stdout?.on('data', (chunk: Buffer) => flush(chunk, false));
    backend.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    backend.on('close', () => flush(Buffer.alloc(0), true));
    backend.on('error', () => flush(Buffer.alloc(0), true));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    get requests(): number {
      return requests;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        // `close` waits for open connections, and git keeps them alive: without this a test run ends
        // with sockets still held and the server never closes.
        server.closeAllConnections();
        // `close` calls back with no argument when it worked, and with an Error when the server was
        // never open: `== null` covers the first, which `=== null` does not and rejected with
        // `undefined` — an error with no message, which vitest reported as "Unknown Error".
        server.close((error?: Error) => (error == null ? resolve() : reject(error)));
      }),
  };
}
