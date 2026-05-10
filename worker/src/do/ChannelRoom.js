import { insertMessage, requireAccessibleRoom } from '../db.js';
import { validateSession } from '../session.js';
import { pickAttachment } from '../utils.js';

const INTERNAL_AUTH_HEADER = 'x-cfchat-internal-auth';
const VERIFIED_USER_ID_HEADER = 'x-cfchat-verified-user-id';
const VERIFIED_IS_ADMIN_HEADER = 'x-cfchat-verified-is-admin';
const VERIFIED_AT_HEADER = 'x-cfchat-verified-at';

function socketMeta(principal, room) {
  return {
    principal,
    room
  };
}

function sendSocketError(ws, message) {
  try {
    ws.send(JSON.stringify({ type: 'error', error: message }));
  } catch {
    // Ignore broken sockets.
  }
}

function parseVerifiedPrincipal(request) {
  if (request.headers.get(INTERNAL_AUTH_HEADER) !== 'worker-verified') {
    return null;
  }

  const userId = Number(request.headers.get(VERIFIED_USER_ID_HEADER) || '');
  const verifiedAt = Number(request.headers.get(VERIFIED_AT_HEADER) || '');
  if (!Number.isFinite(userId) || !Number.isFinite(verifiedAt)) {
    return null;
  }

  return {
    userId,
    isAdmin: request.headers.get(VERIFIED_IS_ADMIN_HEADER) === '1'
  };
}

export class ChannelRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.connections = new Map();

    for (const socket of this.state.getWebSockets()) {
      const meta = socket.deserializeAttachment();
      if (meta) {
        this.connections.set(socket, meta);
      }
    }
  }

  parsePayload(ws, message) {
    try {
      return JSON.parse(message);
    } catch {
      sendSocketError(ws, 'Invalid message payload');
      return null;
    }
  }

  broadcast(packet) {
    for (const socket of this.connections.keys()) {
      try {
        socket.send(packet);
      } catch {
        this.connections.delete(socket);
      }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }

    const token = url.searchParams.get('token') || '';
    const kind = url.searchParams.get('kind') || '';
    const roomId = Number(url.searchParams.get('id') || '');

    let principal = parseVerifiedPrincipal(request);
    if (!principal) {
      const auth = await validateSession(this.env, token);
      if (!auth.ok) {
        return new Response('Unauthorized', { status: 401 });
      }

      principal = {
        userId: auth.session.userId,
        isAdmin: auth.session.isAdmin
      };
    }

    const room = await requireAccessibleRoom(
      this.env.DB,
      principal.userId,
      kind,
      roomId,
      principal.isAdmin
    );

    if (!room) {
      return new Response('Forbidden', { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    const meta = socketMeta(principal, room);
    server.serializeAttachment(meta);
    this.connections.set(server, meta);
    server.send(
      JSON.stringify({
        type: 'ready',
        room: {
          id: Number(room.id),
          kind: room.kind,
          name: room.name
        }
      })
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const meta = this.connections.get(ws);
    if (!meta) {
      return;
    }

    const payload = this.parsePayload(ws, message);
    if (!payload) {
      return;
    }

    if (payload.type !== 'send') {
      sendSocketError(ws, 'Unsupported message type');
      return;
    }

    try {
      const saved = await insertMessage(this.env.DB, {
        channelId: meta.room.id,
        senderId: meta.principal.userId,
        content: payload.content,
        attachment: pickAttachment(payload.attachment)
      });
      const packet = JSON.stringify({
        type: 'message',
        message: saved
      });

      this.broadcast(packet);
    } catch (error) {
      sendSocketError(ws, error.message || 'Send failed');
    }
  }

  webSocketClose(ws) {
    this.connections.delete(ws);
  }

  webSocketError(ws) {
    this.connections.delete(ws);
  }
}
