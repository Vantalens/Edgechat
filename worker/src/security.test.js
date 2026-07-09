import assert from 'node:assert/strict';
import test from 'node:test';
import { insertMessage } from './db.js';
import * as utils from './utils.js';

const { pickAttachment, requestBodyTooLarge } = utils;

test('pickAttachment rejects attachment keys outside the sender namespace', () => {
  const attachment = pickAttachment(
    {
      key: '7/known-object.png',
      name: 'known-object.png',
      type: 'image/png',
      size: 100
    },
    { ownerUserId: 42 }
  );

  assert.equal(attachment, null);
});

test('pickAttachment accepts attachment keys owned by the sender', () => {
  const attachment = pickAttachment(
    {
      key: '42/known-object.png',
      name: 'known-object.png',
      type: 'image/png',
      size: 100
    },
    { ownerUserId: 42 }
  );

  assert.equal(attachment.key, '42/known-object.png');
});

test('requestBodyTooLarge applies route-specific byte limits', () => {
  const request = new Request('https://edgechat.test/api/upload', {
    method: 'POST',
    headers: { 'content-length': '25' }
  });

  assert.equal(requestBodyTooLarge(request, 20), true);
});

test('canMutateAdminUser blocks self-disable', () => {
  assert.equal(typeof utils.canMutateAdminUser, 'function');

  const decision = utils.canMutateAdminUser({
    actorUserId: 1,
    targetUserId: 1,
    targetIsAdmin: true,
    targetWillBeActive: false,
    activeAdminCount: 2
  });

  assert.equal(decision.ok, false);
});

test('canMutateAdminUser blocks disabling the last active admin', () => {
  assert.equal(typeof utils.canMutateAdminUser, 'function');

  const decision = utils.canMutateAdminUser({
    actorUserId: 1,
    targetUserId: 2,
    targetIsAdmin: true,
    targetWillBeActive: false,
    activeAdminCount: 1
  });

  assert.equal(decision.ok, false);
});
test('insertMessage rejects unavailable attachments even when text content exists', async () => {
  const fakeDb = {
    prepare() {
      return {
        bind() {
          return {
            async all() {
              return { results: [] };
            }
          };
        }
      };
    }
  };

  await assert.rejects(
    insertMessage(fakeDb, {
      channelId: 1,
      senderId: 42,
      content: 'with stolen attachment',
      attachment: {
        key: '42/missing-object.png',
        name: 'missing-object.png',
        type: 'image/png',
        size: 100
      }
    }),
    /Attachment is not available/
  );
});