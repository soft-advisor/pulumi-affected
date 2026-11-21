import { createServer, type IncomingMessage } from 'node:http';

export interface ApiCall {
  method: string;
  path: string;
  body: unknown;
}

/** A fake GitHub API answering from `routes` ("GET /path" → response) and recording calls */
export async function fakeApi(routes: Record<string, unknown>) {
  const calls: ApiCall[] = [];
  const server = createServer(async (request: IncomingMessage, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const path = (request.url ?? '').replace(/[?&]per_page=100&page=\d+/, '');
    calls.push({ method: request.method ?? '', path, body: text ? JSON.parse(text) : undefined });
    const page = Number(/[?&]page=(\d+)/.exec(request.url ?? '')?.[1] ?? '1');
    const key = `${request.method} ${path}`;
    if (!(key in routes)) {
      // Like GitHub for a workflow token, which can't read the user it acts as
      const status = key === 'GET /user' ? 403 : 404;
      response.writeHead(status).end('{}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(page > 1 ? [] : routes[key]));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, calls, close: () => server.close() };
}
