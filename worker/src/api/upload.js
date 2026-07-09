import { canAccessFile, recordUploadedFile } from '../db.js';
import { validateSession } from '../session.js';
import { errorResponse, requestBodyTooLarge } from '../utils.js';

const FILE_BROWSER_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const UPLOAD_BODY_OVERHEAD_BYTES = 1024 * 1024;
const BLOCKED_MIME_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/javascript',
  'application/javascript',
  'text/xml',
  'application/xml'
]);

function normalizeContentType(value) {
  return String(value || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

function isInlineContentType(contentType) {
  if (!contentType) {
    return false;
  }
  if (contentType === 'application/pdf') {
    return true;
  }
  if (contentType.startsWith('image/')) {
    return contentType !== 'image/svg+xml';
  }
  if (contentType.startsWith('video/')) {
    return true;
  }
  return false;
}

function sanitizeFilename(value) {
  const cleaned = Array.from(
    String(value || '')
      .trim()
      .replaceAll('/', '_')
      .replaceAll('\\', '_')
  )
    .filter((char) => {
      const code = char.codePointAt(0);
      return code === undefined || (code >= 0x20 && code !== 0x7f);
    })
    .join('');
  return cleaned.slice(0, 180) || 'file';
}

function contentDispositionValue(kind, filename) {
  const safeUtf8 = sanitizeFilename(filename);
  const safeAscii = safeUtf8
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/"/g, '')
    .trim()
    .slice(0, 150) || 'file';
  return `${kind}; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(safeUtf8)}`;
}

function validateUpload(env, file) {
  const maxFileSize = Number(env.MAX_FILE_SIZE || 20971520);
  if (file.size > maxFileSize) {
    throw new Error(`文件大小不能超过 ${Math.round(maxFileSize / 1024 / 1024)}MB`);
  }

  const contentType = normalizeContentType(file.type);
  if (BLOCKED_MIME_TYPES.has(contentType)) {
    throw new Error('该文件类型不允许上传');
  }

  const allowed = String(env.ALLOWED_FILE_TYPES || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (allowed.length && !allowed.some((prefix) => contentType.startsWith(prefix))) {
    throw new Error('该文件类型不允许上传');
  }
}

export function registerUploadRoutes(app) {
  app.post('/api/upload', async (c) => {
    const session = c.get('session');
    const maxFileSize = Number(c.env.MAX_FILE_SIZE || 20971520);
    if (requestBodyTooLarge(c.req.raw, maxFileSize + UPLOAD_BODY_OVERHEAD_BYTES)) {
      return errorResponse(`文件大小不能超过 ${Math.round(maxFileSize / 1024 / 1024)}MB`, 413);
    }
    const formData = await c.req.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) {
      return errorResponse('请选择文件');
    }

    try {
      validateUpload(c.env, file);
    } catch (error) {
      return errorResponse(error.message);
    }

    const extension = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '';
    const key = `${session.userId}/${Date.now()}-${crypto.randomUUID()}${extension}`;
    await c.env.FILES.put(key, await file.arrayBuffer(), {
      httpMetadata: {
        contentType: normalizeContentType(file.type) || 'application/octet-stream',
        cacheControl: FILE_BROWSER_CACHE_CONTROL
      },
      customMetadata: {
        filename: sanitizeFilename(file.name)
      }
    });

    try {
      await recordUploadedFile(c.env.DB, {
        key,
        ownerUserId: session.userId,
        filename: sanitizeFilename(file.name),
        contentType: normalizeContentType(file.type) || 'application/octet-stream',
        size: file.size
      });
    } catch (error) {
      try {
        await c.env.FILES.delete(key);
      } catch (deleteError) {
        console.warn('Failed to delete orphaned upload after metadata error', deleteError);
      }
      throw error;
    }

    return c.json({
      file: {
        key,
        name: file.name,
        type: file.type || 'application/octet-stream',
        size: file.size,
        url: `/files/${encodeURIComponent(key)}`
      }
    });
  });

  app.get('/files/:key{.+}', async (c) => {
    const key = decodeURIComponent(c.req.param('key'));
    const token = c.req.header('authorization')?.startsWith('Bearer ')
      ? c.req.header('authorization').slice('Bearer '.length).trim()
      : new URL(c.req.url).searchParams.get('token') || '';
    const auth = token ? await validateSession(c.env, token) : null;
    const canRead = await canAccessFile(
      c.env.DB,
      key,
      auth?.ok ? auth.session.userId : null,
      auth?.ok ? auth.session.isAdmin : false
    );
    if (!canRead) {
      return new Response('Forbidden', { status: 403 });
    }
    const object = await c.env.FILES.get(key);
    if (!object) {
      return new Response('Not Found', { status: 404 });
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('cache-control', headers.get('cache-control') || FILE_BROWSER_CACHE_CONTROL);
    if (object.uploaded) {
      headers.set('last-modified', object.uploaded.toUTCString());
    }

    headers.set('x-content-type-options', 'nosniff');
    headers.set('referrer-policy', 'no-referrer');
    headers.set(
      'content-security-policy',
      "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'"
    );

    const contentType = normalizeContentType(headers.get('content-type'));
    const inlineAllowed = isInlineContentType(contentType);
    const dispositionKind =
      inlineAllowed && !contentType.startsWith('text/') ? 'inline' : 'attachment';
    const filename = object.customMetadata?.filename || key.split('/').pop() || 'file';
    headers.set('content-disposition', contentDispositionValue(dispositionKind, filename));

    const ifNoneMatch = c.req.header('if-none-match');
    if (ifNoneMatch && ifNoneMatch === object.httpEtag) {
      return new Response(null, {
        status: 304,
        headers
      });
    }

    return new Response(object.body, { headers });
  });
}
