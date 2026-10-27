import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { MAX_AVATAR_BYTES, MAX_STORED_AVATAR_BYTES, validateAvatar, avatarStorageKey, createAvatarService } from '../services/avatars.js';

const fileName = '11111111-1111-4111-8111-111111111111.webp';
const fixture = async () => (await sharp({ create: { width: 600, height: 300, channels: 3, background: '#4263eb' } }).png().toBuffer()).toString('base64');

test('头像完整解码并转换为 256px WebP', async () => {
  const image = await validateAvatar(await fixture(), 'image/png');
  const meta = await sharp(image).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 256);
  assert.equal(meta.height, 256);
  assert(image.length <= MAX_STORED_AVATAR_BYTES);
});

test('头像拒绝超过2MB、MIME伪造和损坏图片', async () => {
  await assert.rejects(() => validateAvatar(Buffer.alloc(MAX_AVATAR_BYTES + 1).toString('base64'), 'image/png'), /2MB/);
  await assert.rejects(() => validateAvatar('AAAA', 'image/png'), /静态图片/);
  const image = await fixture();
  await assert.rejects(() => validateAvatar(image, 'image/jpeg'), /静态图片/);
  await assert.rejects(() => validateAvatar(Buffer.from('<svg/>').toString('base64'), 'image/svg+xml'), /静态图片/);
});

test('头像独立目录与路径校验', () => {
  assert.equal(avatarStorageKey(7, fileName), `user-avatars/7/${fileName}`);
  assert.throws(() => avatarStorageKey('../7', fileName), /不存在/);
  assert.throws(() => avatarStorageKey(7, '../../chat.png'), /不存在/);
  const old = process.env.OSS_PREFIX;
  try {
    process.env.OSS_PREFIX = 'user-avatars/chat';
    assert.throws(() => avatarStorageKey(7, fileName), /重叠/);
  } finally {
    if (old === undefined) delete process.env.OSS_PREFIX;
    else process.env.OSS_PREFIX = old;
  }
});

function harness({ previous = null, failUpdate = false, missingUser = false } = {}) {
  const calls = [];
  let avatar = previous;
  const connection = {
    beginTransaction: async () => calls.push('begin'),
    execute: async (sql, args) => {
      if (sql.startsWith('SELECT')) return [missingUser ? [] : [{ avatar }]];
      if (failUpdate) throw new Error('database failure');
      avatar = args[0];
      return [{ affectedRows: 1 }];
    },
    commit: async () => calls.push('commit'),
    rollback: async () => calls.push('rollback'),
    release: () => calls.push('release'),
  };
  const storage = {
    put: async (key) => calls.push(['put', key]),
    delete: async (key) => calls.push(['delete', key]),
    signatureUrlV4: async (...args) => { calls.push(['sign', ...args]); return 'https://storage.test/signed'; },
  };
  const db = {
    getConnection: async () => connection,
    execute: async () => [[{ avatar }]],
  };
  return { service: createAvatarService({ db, getStorage: () => storage }), calls, current: () => avatar };
}

test('上传后保存稳定地址，提交后仅删除自己的旧头像，读取使用短期签名', async () => {
  const h = harness({ previous: `/api/auth/avatars/7/${fileName}` });
  const avatar = await h.service.upload(7, { data: await fixture(), mimeType: 'image/png' });
  assert.equal(avatar, h.current());
  assert.match(avatar, /^\/api\/auth\/avatars\/7\/[a-f0-9-]+\.webp$/);
  assert(h.calls.indexOf('commit') < h.calls.findIndex(c => c[0] === 'delete'));
  assert.deepEqual(h.calls.find(c => c[0] === 'delete'), ['delete', `user-avatars/7/${fileName}`]);
  const url = await h.service.signedUrl('7', avatar.split('/').pop());
  assert.equal(url, 'https://storage.test/signed');
  await assert.rejects(() => h.service.signedUrl('7', fileName), /不存在/);
});

test('数据库保存失败时回滚并清除本次上传，不删除旧头像', async () => {
  const h = harness({ previous: `/api/auth/avatars/7/${fileName}`, failUpdate: true });
  await assert.rejects(async () => h.service.upload(7, { data: await fixture(), mimeType: 'image/png' }), /上传失败/);
  assert(h.calls.includes('rollback'));
  assert(!h.calls.includes('commit'));
  const put = h.calls.find(c => c[0] === 'put');
  assert.deepEqual(h.calls.find(c => c[0] === 'delete'), ['delete', put[1]]);
});

test('上传被拒绝时不访问OSS；不删除聊天图片或其他用户头像', async () => {
  const invalid = harness();
  await assert.rejects(() => invalid.service.upload(7, { data: 'A'.repeat(Math.ceil(MAX_AVATAR_BYTES / 3) * 4 + 4), mimeType: 'image/png' }));
  assert.equal(invalid.calls.length, 0);
  for (const previous of [`/api/auth/avatars/8/${fileName}`, 'https://example.com/avatar.png', 'snapui/attachments/7/test.png']) {
    const h = harness({ previous });
    await h.service.upload(7, { data: await fixture(), mimeType: 'image/png' });
    assert(!h.calls.some(c => c[0] === 'delete'));
  }
});


test('原图恰好2MB可接受，多1字节被拒绝', async () => {
  const original = Buffer.from(await fixture(), 'base64');
  const image = Buffer.concat([original, Buffer.alloc(MAX_AVATAR_BYTES - original.length)]);
  const result = await validateAvatar(image.toString('base64'), 'image/png');
  assert(result.length <= MAX_STORED_AVATAR_BYTES);
  await assert.rejects(() => validateAvatar(Buffer.concat([image, Buffer.alloc(1)]).toString('base64'), 'image/png'), /2MB/);
});

test('复杂透明图首次编码超过100KB时自动降质量，仍输出256px WebP', async () => {
  // 固定噪声图覆盖真实 WebP 编码的降质量分支。
  const pixels = Buffer.alloc(256 * 256 * 4);
  let seed = 123456789;
  for (let i = 0; i < pixels.length; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    pixels[i] = seed & 255;
  }
  const original = await sharp(pixels, { raw: { width: 256, height: 256, channels: 4 } }).png().toBuffer();
  assert(original.length > 500 * 1024 / 2);
  assert(original.length <= MAX_AVATAR_BYTES);
  const first = await sharp(original).webp({ quality: 85 }).toBuffer();
  assert(first.length > MAX_STORED_AVATAR_BYTES);
  const result = await validateAvatar(original.toString('base64'), 'image/png');
  assert(result.length <= MAX_STORED_AVATAR_BYTES);
  const meta = await sharp(result).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 256);
  assert.equal(meta.height, 256);
});
