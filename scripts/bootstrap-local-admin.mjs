#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hashPassword } from '../worker/src/auth.js';

const username = String(process.env.EDGECHAT_ADMIN_USERNAME || 'admin').trim();
const password = String(process.env.EDGECHAT_ADMIN_PASSWORD || 'admin123');
const displayName = String(process.env.EDGECHAT_ADMIN_DISPLAY_NAME || 'Administrator').trim();

function escapeSql(value) {
  return String(value).replace(/'/g, "''");
}

async function main() {
  const hashed = await hashPassword(password);

  const safeUsername = escapeSql(username);
  const safeDisplayName = escapeSql(displayName || username);
  const safeHash = escapeSql(hashed.hash);
  const safeSalt = escapeSql(hashed.salt);

  const sql = `
INSERT INTO users (
  username,
  display_name,
  password_hash,
  password_salt,
  is_admin,
  is_disabled
)
SELECT
  '${safeUsername}',
  '${safeDisplayName}',
  '${safeHash}',
  '${safeSalt}',
  1,
  0
WHERE NOT EXISTS (
  SELECT 1 FROM users WHERE username = '${safeUsername}'
);

UPDATE users
SET
  is_admin = 1,
  is_disabled = 0,
  deleted_at = NULL,
  updated_at = CURRENT_TIMESTAMP
WHERE username = '${safeUsername}';
`.trim();

  const outputDir = resolve(process.cwd(), '.tmp');
  const outputPath = resolve(outputDir, 'edgechat-local-admin-upsert.sql');
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(outputPath, `${sql}\n`, 'utf8');

  console.log(`Generated local admin bootstrap SQL: ${outputPath}`);
  console.log(`Local admin username: ${username}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
