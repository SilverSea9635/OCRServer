import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { pool } from '../config.js';

export class ModelProfileError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function encryptionKey() {
  const key = Buffer.from(process.env.MODEL_PROFILE_ENCRYPTION_KEY || '', 'base64');
  if ( key.length !== 32 ) throw new ModelProfileError('模型配置存储未启用，请配置服务端加密密钥', 503);
  return key;
}

function encrypt(secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([ cipher.update(secret, 'utf8'), cipher.final() ]);
  return Buffer.from(JSON.stringify({
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64')
  }));
}

function decrypt(blob) {
  try {
    const value = JSON.parse(Buffer.from(blob).toString());
    if ( value.v !== 1 ) throw new Error('unsupported cipher');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([ decipher.update(Buffer.from(value.data, 'base64')), decipher.final() ]).toString('utf8');
  } catch {
    throw new ModelProfileError('模型凭据无法解密，请检查服务端密钥或重新保存配置', 503);
  }
}

function publicProfile(row) {
  return {
    id: row.id, label: row.label, provider: row.provider, baseUrl: row.base_url, modelName: row.model_name,
    keyMask: row.key_last4 ? `****${row.key_last4}` : '已设置', isDefault: Boolean(row.is_default)
  };
}

function validate(input, existing) {
  const text = (key, max) => {
    const value = typeof input[ key ] === 'string' ? input[ key ].trim() : '';
    if ( !value || value.length > max || /[\r\n\u0000]/.test(value) ) throw new ModelProfileError(`${key} 格式不正确`);
    return value;
  };
  const label = text('label', 64), modelName = text('modelName', 128), baseUrl = text('baseUrl', 512);
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ModelProfileError('服务地址格式不正确');
  }
  if ( url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || ( url.port && url.port !== '443' ) ) {
    throw new ModelProfileError('服务地址必须为 HTTPS，且不能包含凭据、查询参数或非标准端口');
  }
  const allowed = ( process.env.ALLOWED_MODEL_HOSTS || '' ).split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
  if ( !allowed.includes(url.hostname.toLowerCase()) ) throw new ModelProfileError('该服务域名未启用，请联系管理员加入允许列表');
  if ( input.provider && input.provider !== 'openai-compatible' ) throw new ModelProfileError('目前支持 OpenAI 兼容接口');
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if ( ( !apiKey && !existing ) || apiKey.length > 2048 || /[\r\n\u0000]/.test(apiKey) ) throw new ModelProfileError('API Key 格式不正确');
  if ( typeof input.isDefault !== 'boolean' ) throw new ModelProfileError('isDefault 必须为布尔值');
  return { label, modelName, baseUrl: url.toString().replace(/\/$/, ''), apiKey, isDefault: input.isDefault };
}

export async function listModelProfiles(userId) {
  encryptionKey();
  const [ rows ] = await pool.execute('SELECT id, label, provider, base_url, model_name, key_last4, is_default FROM model_profiles WHERE user_id = ? ORDER BY is_default DESC, created_at DESC', [ String(userId) ]);
  return rows.map(publicProfile);
}

export async function saveModelProfile(userId, input, id) {
  encryptionKey();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    // 用用户行串行化同一账号的并发保存，保证最多一个默认配置。
    await connection.execute('SELECT id FROM users WHERE id = ? FOR UPDATE', [ userId ]);
    let existing;
    if ( id ) {
      const [ rows ] = await connection.execute('SELECT * FROM model_profiles WHERE id = ? AND user_id = ? FOR UPDATE', [ id, String(userId) ]);
      existing = rows[ 0 ];
      if ( !existing ) throw new ModelProfileError('模型配置不存在', 404);
    }
    const value = validate(input, existing);
    const profileId = id || randomUUID();
    if ( value.isDefault ) await connection.execute('UPDATE model_profiles SET is_default = 0 WHERE user_id = ?', [ String(userId) ]);
    const cipher = value.apiKey ? encrypt(value.apiKey) : existing.api_key_cipher;
    const last4 = value.apiKey ? ( value.apiKey.length > 4 ? value.apiKey.slice(-4) : null ) : existing.key_last4;
    if ( id ) {
      await connection.execute('UPDATE model_profiles SET label = ?, base_url = ?, model_name = ?, api_key_cipher = ?, key_last4 = ?, is_default = ? WHERE id = ? AND user_id = ?', [ value.label, value.baseUrl, value.modelName, cipher, last4, value.isDefault ? 1 : 0, profileId, String(userId) ]);
    } else {
      const [ [ { count } ] ] = await connection.execute('SELECT COUNT(*) AS count FROM model_profiles WHERE user_id = ?', [ String(userId) ]);
      if ( count >= 20 ) throw new ModelProfileError('最多保存 20 个模型配置');
      await connection.execute('INSERT INTO model_profiles (id, user_id, label, provider, base_url, model_name, api_key_cipher, key_last4, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [ profileId, String(userId), value.label, 'openai-compatible', value.baseUrl, value.modelName, cipher, last4, value.isDefault ? 1 : 0 ]);
    }
    await connection.commit();
    return publicProfile({
      id: profileId,
      label: value.label,
      provider: 'openai-compatible',
      base_url: value.baseUrl,
      model_name: value.modelName,
      key_last4: last4,
      is_default: value.isDefault
    });
  } catch ( error ) {
    await connection.rollback();
    if ( error.code === 'ER_DUP_ENTRY' ) throw new ModelProfileError('模型显示名称已存在', 409);
    throw error;
  } finally {
    connection.release();
  }
}

export async function deleteModelProfile(userId, id) {
  const [ result ] = await pool.execute('DELETE FROM model_profiles WHERE id = ? AND user_id = ?', [ id, String(userId) ]);
  if ( !result.affectedRows ) throw new ModelProfileError('模型配置不存在', 404);
}

export async function resolveModelProfile(userId, id) {
  if ( typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id) ) throw new ModelProfileError('模型配置 ID 不正确');
  const [ rows ] = await pool.execute('SELECT * FROM model_profiles WHERE id = ? AND user_id = ?', [ id, String(userId) ]);
  const row = rows[ 0 ];
  if ( !row ) throw new ModelProfileError('模型配置不存在', 404);
  validate({
    label: row.label,
    modelName: row.model_name,
    baseUrl: row.base_url,
    isDefault: Boolean(row.is_default)
  }, row);
  return {
    provider: 'openai-compatible',
    baseUrl: row.base_url,
    modelName: row.model_name,
    apiKey: decrypt(row.api_key_cipher)
  };
}
