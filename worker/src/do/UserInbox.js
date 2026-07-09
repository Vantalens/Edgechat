import { validateSession } from '../session.js';

const INTERNAL_AUTH_HEADER = 'x-cfchat-internal-auth';
const VERIFIED_USER_ID_HEADER = 'x-cfchat-verified-user-id';
const VERIFIED_SESSION_TOKEN_HEADER = 'x-cfchat-verified-session-token';

function parseVerifiedPrincipal(request) {
  if (request.headers.get(INTERNAL_AUTH_HEADER) !== 'worker-verified') {
    return null;
  }

  const userId = Number(request.headers.get(VERIFIED_USER_ID_HEADER) || '');
  const token =
    request.headers.get(VERIFIED_SESSION_TOKEN_HEADER) ||
    new URL(request.url).searchParams.get('token') ||
    '';
  if (!Number.isFinite(userId) || !token) {
    return null;
  }

  return { userId, token };
}

export class UserInbox {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.connections = new Set();

    for (const socket of this.state.getWebSockets()) {
      this.connections.add(socket);
    }
  }

  async revalidateSocket(socket) {
    const meta = socket.deserializeAttachment();
    if (!meta?.token || !Number.isFinite(Number(meta.userId))) {
      this.connections.delete(socket);
      try {
        socket.close(1008, 'Unauthorized');
      } catch {
        // Ignore broken sockets.
      }
      return false;
    }

    const auth = await validateSession(this.env, meta.token);
    if (!auth.ok || Number(auth.session.userId) !== Number(meta.userId)) {
      this.connections.delete(socket);
      try {
        socket.close(1008, 'Unauthorized');
      } catch {
        // Ignore broken sockets.
      }
      return false;
    }

    return true;
  }

  async broadcast(packet) {
    for (const socket of this.connections) {
      if (!(await this.revalidateSocket(socket))) {
        continue;
      }

      try {
        socket.send(packet);
      } catch {
        this.connections.delete(socket);
      }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/connect') {
      const principal = parseVerifiedPrincipal(request);
      if (!principal) {
        return new Response('Unauthorized', { status: 401 });
      }

      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected websocket', { status: 426 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      server.serializeAttachment(principal);
      this.connections.add(server);
      server.send(JSON.stringify({ type: 'ready' }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/notify' && request.method === 'POST') {
      if (request.headers.get(INTERNAL_AUTH_HEADER) !== 'worker-verified') {
        return new Response('Unauthorized', { status: 401 });
      }

      const payload = await request.json();
      await this.broadcast(JSON.stringify(payload));
      return Response.json({ ok: true });
    }

    return new Response('Not Found', { status: 404 });
  }

  webSocketClose(ws) {
    this.connections.delete(ws);
  }

  webSocketError(ws) {
    this.connections.delete(ws);
  }
}
