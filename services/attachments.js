import OSS from 'ali-oss';
import sharp from 'sharp';
import { randomUUID, createHash } from 'node:crypto';
import { pool, AGENT_SERVICE_URL } from '../config.js';
import { getRemoteMessage } from './agent_sessions.js';

export class AttachmentError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
let storage;

export function ossClient() {
  if ( storage ) return storage;
  const { OSS_BUCKET, OSS_REGION, OSS_ENDPOINT, OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET } = process.env;
  if ( !OSS_BUCKET || !OSS_REGION || !OSS_ENDPOINT || !OSS_ACCESS_KEY_ID || !OSS_ACCESS_KEY_SECRET ) throw new AttachmentError('图片存储未配置', 503);
  if ( !OSS_ENDPOINT.startsWith('https://') ) throw new AttachmentError('图片存储必须使用 HTTPS', 503);
  storage = new OSS({
    bucket: OSS_BUCKET,
    region: OSS_REGION.startsWith('oss-') ? OSS_REGION : `oss-${OSS_REGION}`,
    endpoint: OSS_ENDPOINT,
    accessKeyId: OSS_ACCESS_KEY_ID,
    accessKeySecret: OSS_ACCESS_KEY_SECRET,
    secure: true,
    authorizationV4: true,
    timeout: 30000
  });
  return storage;
}

export async function validateImage(data, mimeType) {
  if ( typeof data !== 'string' ) throw new AttachmentError('图片数据格式不正确');
  const base64 = data.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
  if ( base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0 ) throw new AttachmentError('图片格式不正确或超过 2MB');
  const input = Buffer.from(base64, 'base64');
  if ( !input.length || input.length > MAX_IMAGE_BYTES ) throw new AttachmentError('图片大小不能超过 2MB');
  try {
    const image = sharp(input, { limitInputPixels: 20000000, failOn: 'warning' });
    const metadata = await image.metadata();
    const types = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
    if ( !types[ metadata.format ] || types[ metadata.format ] !== mimeType || ( metadata.pages || 1 ) > 1 ) throw new Error('invalid format');
    // 完整解码再编码，移除 EXIF 等隐藏信息，拒绝损坏图片与动图。
    const { data: buffer, info } = await image.rotate().toBuffer({ resolveWithObject: true });
    if ( buffer.length > MAX_IMAGE_BYTES ) throw new AttachmentError('处理后的图片超过 2MB');
    return {
      buffer,
      mimeType: types[ info.format ],
      width: info.width,
      height: info.height,
      extension: info.format === 'jpeg' ? 'jpg' : info.format
    };
  } catch ( error ) {
    if ( error instanceof AttachmentError ) throw error;
    throw new AttachmentError('仅支持有效的 PNG、JPEG、WebP 静态图片');
  }
}

export async function uploadAttachment(userId, { data, mimeType, fileName = '截图' }) {
  const image = await validateImage(data, mimeType);
  const id = randomUUID();
  const prefix = ( process.env.OSS_PREFIX || 'snapui/attachments/' ).replace(/^\/+|\/+$/g, '');
  const key = `${prefix}/${userId}/${id}.${image.extension}`;
  const client = ossClient();
  // 先登记 uploading，确保网络失败或进程中断后仍有可回收的对象 key。
  await pool.execute('INSERT INTO image_attachments(id,user_id,storage_key,file_name,mime_type,size_bytes,width,height,sha256,state) VALUES(?,?,?,?,?,?,?,?,?,?)', [ id, userId, key, String(fileName).split(/[\\/]/).pop().slice(0, 255) || '截图', image.mimeType, image.buffer.length, image.width, image.height, createHash('sha256').update(image.buffer).digest('hex'), 'uploading' ]);
  try {
    await client.put(key, image.buffer, {
      mime: image.mimeType,
      headers: { 'x-oss-forbid-overwrite': 'true', 'Cache-Control': 'private, max-age=300' }
    });
    await pool.execute('UPDATE image_attachments SET state=? WHERE id=?', [ 'ready', id ]);
  } catch {
    try {
      await client.delete(key);
      await pool.execute('DELETE FROM image_attachments WHERE id=?', [ id ]);
    } catch {
    }
    throw new AttachmentError('图片上传失败，请稍后重试', 502);
  }
  return attachmentView(userId, id);
}

export async function ownedAttachment(userId, id) {
  if ( typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id) ) throw new AttachmentError('附件不存在', 404);
  const [ [ row ] ] = await pool.execute('SELECT * FROM image_attachments WHERE id=? AND user_id=? AND state=?', [ id, userId, 'ready' ]);
  if ( !row ) throw new AttachmentError('附件不存在或不可访问', 404);
  return row;
}

export async function attachmentView(userId, id) {
  const row = await ownedAttachment(userId, id);
  const url = await ossClient().signatureUrlV4('GET', 300, {}, row.storage_key);
  return {
    id: row.id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    width: row.width,
    height: row.height,
    sha256: row.sha256,
    url,
    expiresAt: Date.now() + 300000
  };
}

export function imageReference(row) {
  return {
    type: 'image',
    attachmentId: row.id,
    source: { type: 'attachment', media_type: row.mime_type, bytes: row.size_bytes },
    fileName: row.file_name,
    width: row.width,
    height: row.height
  };
}

export async function messageWithAttachment(userId, message, id) {
  if ( !id ) return message;
  if ( typeof message !== 'string' ) throw new AttachmentError('图片引用消息必须同时使用文字输入');
  return [ imageReference(await ownedAttachment(userId, id)), { type: 'text', text: message } ];
}

export async function materializeImages(message, userId) {
  if ( !Array.isArray(message) ) return message;
  return Promise.all(message.map(async block => {
    if ( block.type !== 'image' || !block.attachmentId ) return block;
    const row = await ownedAttachment(userId, block.attachmentId);
    let result;
    try {
      result = await ossClient().get(row.storage_key);
    } catch {
      throw new AttachmentError('截图读取失败，请稍后重试', 502);
    }
    if ( result.content.length > MAX_IMAGE_BYTES ) throw new AttachmentError('截图大小异常');
    return {
      type: 'image',
      source: { type: 'base64', media_type: row.mime_type, data: result.content.toString('base64') }
    };
  }));
}

export function textOnlyHistory(history) {
  return history.map(entry => ( {
    ...entry,
    content: Array.isArray(entry.content)
    ? ( entry.content.filter(block => block.type === 'text').length
        ? entry.content.filter(block => block.type === 'text')
        : '[用户在此轮上传过截图]' )
    : entry.content
  } )).filter(entry => typeof entry.content === 'string' ? entry.content.length > 0 : entry.content.length > 0);
}

export async function enrichImageHistory(messages, userId) {
  return Promise.all(messages.map(async message => {
    if ( !Array.isArray(message.content) ) return message;
    const content = await Promise.all(message.content.map(async block => {
      if ( block.type !== 'image' || !block.attachmentId ) return block;
      try {
        return { ...block, attachment: await attachmentView(userId, block.attachmentId) };
      } catch {
        return { ...block, imageUnavailable: true };
      }
    }));
    return { ...message, content };
  }));
}

export async function deleteUnusedAttachment(userId, id) {
  const connection = await pool.getConnection();
  let key;
  try {
    await connection.beginTransaction();
    const [ [ row ] ] = await connection.execute('SELECT * FROM image_attachments WHERE id=? AND user_id=? FOR UPDATE', [ id, userId ]);
    if ( !row ) throw new AttachmentError('附件不存在', 404);
    const [ [ { count } ] ] = await connection.execute('SELECT COUNT(*) AS count FROM message_image_attachments WHERE attachment_id=?', [ id ]);
    if ( count ) throw new AttachmentError('截图已被历史消息引用，不能删除', 409);
    key = row.storage_key;
    await connection.execute('UPDATE image_attachments SET state=? WHERE id=?', [ 'deleting', id ]);
    await connection.commit();
  } catch ( error ) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  try {
    await ossClient().delete(key);
    await pool.execute('DELETE FROM image_attachments WHERE id=? AND state=?', [ id, 'deleting' ]);
  } catch {
    throw new AttachmentError('删除暂未完成，已进入清理队列', 502);
  }
}

export async function cleanupUnusedAttachments({ ageHours = 24 } = {}) {
  await reconcilePendingMessageAttachments();
  const [ rows ] = await pool.query("SELECT id,user_id FROM image_attachments a WHERE (state='deleting' OR created_at < DATE_SUB(NOW(), INTERVAL ? HOUR)) AND NOT EXISTS (SELECT 1 FROM message_image_attachments m WHERE m.attachment_id=a.id) LIMIT 100", [ ageHours ]);
  let deleted = 0;
  for ( const row of rows ) {
    try {
      await deleteUnusedAttachment(row.user_id, row.id);
      deleted++;
    } catch {/* 删除失败保留记录，下次重试。 */
    }
  }
  return deleted;
}


export async function reserveMessageAttachments(userId, conversationId, messageId, content, dbPool = pool) {
  const ids = Array.isArray(content) ? [...new Set(content.filter(block => block.type === 'image' && block.attachmentId).map(block => block.attachmentId))].sort() : [];
  if (!ids.length) return;
  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const [[owned]] = await connection.execute('SELECT conversation_id FROM conversations WHERE conversation_id=? AND user_id=? FOR UPDATE', [conversationId, userId]);
    if (!owned) throw new AttachmentError('会话不存在', 404);
    for (const id of ids) {
      const [[image]] = await connection.execute('SELECT id FROM image_attachments WHERE id=? AND user_id=? AND state=? FOR UPDATE', [id, userId, 'ready']);
      if (!image) throw new AttachmentError('截图已删除或不可访问', 404);
      await connection.execute('INSERT IGNORE INTO message_image_attachments(message_id,attachment_id,conversation_id) VALUES(?,?,?)', [messageId, id, conversationId]);
    }
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

export async function confirmMessageAttachments(messageId, dbPool = pool) {
  await dbPool.execute("UPDATE message_image_attachments SET state='committed' WHERE message_id=?", [messageId]);
}

export async function reconcilePendingMessageAttachments() {
  const [rows] = await pool.query("SELECT DISTINCT m.message_id,m.conversation_id,c.user_id FROM message_image_attachments m JOIN conversations c ON c.conversation_id=m.conversation_id WHERE m.state='pending' AND m.created_at < DATE_SUB(NOW(),INTERVAL 1 HOUR) LIMIT 100");
  for (const row of rows) {
    try {
      await getRemoteMessage({ conversationId: row.conversation_id, messageId: row.message_id, userId: row.user_id, agentServiceUrl: AGENT_SERVICE_URL, secret: process.env.INTERNAL_API_TOKEN });
      await confirmMessageAttachments(row.message_id);
    } catch (error) {
      // 只有远端明确确认消息不存在或会话已删除，才释放引用；网络异常时保留保护。
      if ([404, 410].includes(error.statusCode)) await pool.execute("DELETE FROM message_image_attachments WHERE message_id=? AND state='pending'", [row.message_id]);
    }
  }
}
