import type { JsonValue } from '../packages/cli/src/index.js';

type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

export function fakeFetch(handler: FetchHandler): typeof fetch {
  return async (input, init = {}) =>
    handler(input instanceof Request ? input.url : String(input), init);
}

export function jsonResponse(body: JsonValue, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

export function sentHeaders(init: RequestInit): Headers {
  return new Headers(init.headers);
}

export function sentBody(init: RequestInit): JsonValue {
  return JSON.parse(String(init.body));
}

export async function rejectionOf<T extends Error>(
  promise: Promise<unknown>,
  kind: abstract new (...args: never[]) => T,
): Promise<T> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof kind) return err;

    throw err;
  }

  throw new Error('expected the promise to reject');
}
