import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { pool } from '../config.js';
import { AttachmentError, ossClient } from './attachments.js';

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
export const MAX_STORED_AVATAR_BYTES = 100 * 1024;
const AVATAR_PREFIX = 'user-avatars';
const avatarPath = /^\/api\/auth\/avatars\/(\d+)\/([a-f0-9-]{36}\.webp)$/;

export function avatarStorageKey(userId, fileName) {
  if (!/^\d+$/.test(String(userId)) || !/^[a-f0-9-]{36}\.webp$/.test(fileName)) throw new AttachmentError('头像不存在', 404);
  const chatPrefix = (process.env.OSS_PREFIX || 'snapui/attachments/').replace(/^\/+|\/+$/g, '');
  if (!chatPrefix || chatPrefix === AVATAR_PREFIX || chatPrefix.startsWith(`${AVATAR_PREFIX}/`) || AVATAR_PREFIX.startsWith(`${chatPrefix}/`)) {
    throw new AttachmentError('头像目录不能与聊天图片目录重叠', 503);
  }
  return `${AVATAR_PREFIX}/${userId}/${fileName}`;
}

export async function validateAvatar(data, mimeType) {
  if (typeof data !== 'string') throw new AttachmentError('请选择头像图片');
  const base64 = data.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
  if (base64.length > Math.ceil(MAX_AVATAR_BYTES / 3) * 4) throw new AttachmentError('头像原图大小不能超过 2MB', 413);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4) throw new AttachmentError('头像图片格式不正确');
  const input = Buffer.from(base64, 'base64');
  if (!input.length || input.length > MAX_AVATAR_BYTES) throw new AttachmentError('头像原图大小不能超过 2MB', 413);
  try {
    const image = sharp(input, { limitInputPixels: 20000000, failOn: 'warning' });
    const meta = await image.metadata();
    const types = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
    if (!types[meta.format] || types[meta.format] !== mimeType || (meta.pages || 1) > 1) throw new Error('invalid image');
    const resized = image.rotate().resize(256, 256, { fit: 'cover', withoutEnlargement: true });
    // 每次从同一原图编码，避免对已压缩的 WebP 反复转码损伤画质。
    for (const quality of [85, 75, 65, 50, 35, 20, 10, 1]) {
      const buffer = await resized.clone().webp({ quality }).toBuffer();
      if (buffer.length <= MAX_STORED_AVATAR_BYTES) return buffer;
    }
    throw new AttachmentError('头像压缩后仍超过 100KB，请选择内容更简单的图片', 413);
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    throw new AttachmentError('仅支持有效的 PNG、JPEG、WebP 静态图片');
  }
}

export function createAvatarService({ db = pool, getStorage = ossClient } = {}) {
  return {
    async upload(userId, { data, mimeType } = {}) {
      const buffer = await validateAvatar(data, mimeType);
      const fileName = `${randomUUID()}.webp`;
      const key = avatarStorageKey(userId, fileName);
      const avatar = `/api/auth/avatars/${userId}/${fileName}`;
      const client = getStorage();
      let connection;
      let previous;
      try {
        await client.put(key, buffer, { mime: 'image/webp', headers: { 'x-oss-forbid-overwrite': 'true', 'Cache-Control': 'private, max-age=300' } });
        connection = await db.getConnection();
        await connection.beginTransaction();
        const [[user]] = await connection.execute('SELECT avatar FROM users WHERE id=? FOR UPDATE', [userId]);
        if (!user) throw new AttachmentError('用户不存在', 404);
        previous = user.avatar;
        await connection.execute('UPDATE users SET avatar=? WHERE id=?', [avatar, userId]);
        await connection.commit();
      } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        await client.delete(key).catch(() => {});
        if (error instanceof AttachmentError) throw error;
        throw new AttachmentError('头像上传失败，请稍后重试', 502);
      } finally {
        connection?.release();
      }
      const old = typeof previous === 'string' ? previous.match(avatarPath) : null;
      if (old && old[1] === String(userId)) {
        await client.delete(avatarStorageKey(userId, old[2])).catch(() => console.error('旧头像清理失败'));
      }
      return avatar;
    },
    async signedUrl(userId, fileName) {
      const key = avatarStorageKey(userId, fileName);
      const [[user]] = await db.execute('SELECT avatar FROM users WHERE id=?', [userId]);
      if (user?.avatar !== `/api/auth/avatars/${userId}/${fileName}`) throw new AttachmentError('头像不存在', 404);
      return getStorage().signatureUrlV4('GET', 300, {}, key);
    },
  };
}
