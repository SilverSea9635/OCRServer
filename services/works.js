import { createHash } from 'node:crypto';
import { pool } from '../config.js';

/**
 * 作品广场数据访问层（真相源是 works 表）。
 *
 * 设计取舍：
 * - 收藏数 / 引用数实时 COUNT，不在 works 上冗余计数列 —— 作品体量小，正确性优先。
 * - 不公开作品（is_public=0）只有作者本人可见，其他人一律当"不存在"处理，不泄露存在性。
 * - 引用血缘（source_work_id）不建外键：来源作品被删除后派生作品要存活，血缘退化为"原创"。
 */

export class WorkError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'WorkError';
    this.statusCode = statusCode;
  }
}

const MAX_TAGS = 6;
const MAX_TAG_LENGTH = 24;

// ─── 工具 ───

function toTags(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeTagList(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  for (const tag of tags) {
    const text = String(tag ?? '').trim().slice(0, MAX_TAG_LENGTH);
    if (text) seen.add(text);
    if (seen.size >= MAX_TAGS) break;
  }
  return Array.from(seen);
}

function truncate(text, max) {
  const value = typeof text === 'string' ? text.trim() : '';
  return value.length > max ? value.slice(0, max) : value;
}

function digestOf(code) {
  // 规范化空白后再指纹化：同一份代码多打一个换行不该产生两个作品
  const normalized = String(code || '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex');
}

function mapWork(row) {
  const sourceWorkId = row.source_work_id ? Number(row.source_work_id) : null;
  const sourceWorkTitle = row.source_work_title;

  return {
    id: Number(row.id),
    title: row.title,
    description: row.description || '',
    sourceCode: row.source_code,
    tags: toTags(row.tags),
    isPublic: Boolean(row.is_public),
    previewImage: row.preview_image || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    author: {
      id: Number(row.user_id),
      nickname: row.author_nickname || '匿名',
      avatar: row.author_avatar || null,
    },
    favoriteCount: Number(row.favorite_count || 0),
    referenceCount: Number(row.reference_count || 0),
    favorited: Boolean(row.favorited),
    isOwner: Boolean(row.is_owner),
    sourceWork:
      sourceWorkId && sourceWorkTitle
        ? {
            id: sourceWorkId,
            title: sourceWorkTitle,
            author: {
              id: row.source_author_id ? Number(row.source_author_id) : 0,
              nickname: row.source_author_nickname || '匿名',
            },
          }
        : null,
  };
}

/** 列表与详情共用的投影：统计与作者信息都在 SQL 里算完，避免 N+1 */
const WORK_COLUMNS = `
  w.id, w.user_id, w.title, w.description, w.source_code, w.preview_image, w.tags,
  w.is_public, w.source_work_id, w.created_at, w.updated_at,
  u.nickname AS author_nickname, u.avatar AS author_avatar,
  (SELECT COUNT(*) FROM work_favorites f WHERE f.work_id = w.id) AS favorite_count,
  (SELECT COUNT(*) FROM work_references r WHERE r.source_work_id = w.id) AS reference_count,
  EXISTS(SELECT 1 FROM work_favorites f2 WHERE f2.work_id = w.id AND f2.user_id = ?) AS favorited,
  (w.user_id = ?) AS is_owner
`;

function columnsWithViewer() {
  return WORK_COLUMNS;
}

/** 批量补齐"引用自"信息（列表场景，避免逐行 JOIN） */
async function attachSourceWorks(works) {
  const sourceIds = Array.from(new Set(works.map((w) => w.sourceWork?.id).filter(Boolean)));
  if (sourceIds.length === 0) return works;

  const placeholders = sourceIds.map(() => '?').join(', ');
  const [rows] = await pool.execute(
    `SELECT w.id, w.title, w.user_id, u.nickname AS author_nickname
     FROM works w JOIN users u ON u.id = w.user_id
     WHERE w.id IN (${placeholders})`,
    sourceIds,
  );

  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  for (const work of works) {
    if (!work.sourceWork) continue;
    const source = byId.get(work.sourceWork.id);
    if (!source) {
      // 来源作品已被删除：血缘在数据库里还留着，但对外呈现为原创
      work.sourceWork = null;
      continue;
    }
    work.sourceWork.title = source.title;
    work.sourceWork.author = {
      id: Number(source.user_id),
      nickname: source.author_nickname || '匿名',
    };
  }
  return works;
}

// ─── 查询 ───

/**
 * 作品列表。
 * @param scope 'public' 公开广场 | 'mine' 我的作品（含私密）| 'favorites' 我收藏的
 */
export async function listWorks({ viewerId = null, scope = 'public', sort = 'latest', q = '', page = 1, pageSize = 12 } = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.min(50, Math.max(1, Number(pageSize) || 12));
  const offset = (safePage - 1) * safePageSize;
  const viewer = viewerId ?? 0;
  const keyword = typeof q === 'string' ? q.trim() : '';

  const where = [];
  const params = [];

  if (scope === 'mine') {
    where.push('w.user_id = ?');
    params.push(viewer);
  } else if (scope === 'favorites') {
    where.push('EXISTS(SELECT 1 FROM work_favorites fv WHERE fv.work_id = w.id AND fv.user_id = ?)');
    params.push(viewer);
  } else {
    where.push('w.is_public = 1');
  }

  if (keyword) {
    // 转义 LIKE 通配符：否则搜 "%" 或 "_" 会匹配到全部作品（已实测复现）
    const escaped = keyword.replace(/[\\%_]/g, (char) => `\\${char}`);
    where.push('(w.title LIKE ? OR w.description LIKE ? OR CAST(w.tags AS CHAR) LIKE ?)');
    const like = `%${escaped}%`;
    params.push(like, like, like);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const orderSql = sort === 'hot'
    ? 'ORDER BY favorite_count DESC, w.created_at DESC'
    : 'ORDER BY w.created_at DESC';

  const [countRows] = await pool.execute(
    `SELECT COUNT(*) AS total FROM works w ${whereSql}`,
    params,
  );

  // viewer 占位符在 SELECT 列表里，位置必须在 WHERE 参数之前
  const [rows] = await pool.query(
    `SELECT ${columnsWithViewer()}
     FROM works w
     JOIN users u ON u.id = w.user_id
     ${whereSql}
     ${orderSql}
     LIMIT ${Number(safePageSize)} OFFSET ${Number(offset)}`,
    [viewer, viewer, ...params],
  );

  const works = await attachSourceWorks(rows.map(mapWork));

  return {
    total: Number(countRows[0].total || 0),
    page: safePage,
    pageSize: safePageSize,
    works,
  };
}

/** 作品详情；返回 null 表示不存在或对当前查看者不可见 */
export async function getWorkById(id, viewerId = null, { withSourceWorks = false } = {}) {
  const workId = Number(id);
  if (!Number.isInteger(workId) || workId <= 0) return null;

  const viewer = viewerId ?? 0;
  const [rows] = await pool.query(
    `SELECT ${columnsWithViewer()},
       sw.id AS source_work_id_ref, sw.title AS source_work_title,
       sw.user_id AS source_author_id, su.nickname AS source_author_nickname
     FROM works w
     JOIN users u ON u.id = w.user_id
     LEFT JOIN works sw ON sw.id = w.source_work_id
     LEFT JOIN users su ON su.id = sw.user_id
     WHERE w.id = ? AND (w.is_public = 1 OR w.user_id = ?)`,
    [viewer, viewer, workId, viewer],
  );

  if (rows.length === 0) return null;

  const work = mapWork(rows[0]);

  if (withSourceWorks) {
    // 详情页展示「由此派生的作品」（仅列出查看者有权看到的：公开的，或自己的）
    const [derived] = await pool.query(
      `SELECT w.id, w.title, w.user_id, u.nickname AS author_nickname
       FROM works w JOIN users u ON u.id = w.user_id
       WHERE w.source_work_id = ? AND (w.is_public = 1 OR w.user_id = ?)
       ORDER BY w.created_at DESC
       LIMIT 20`,
      [workId, viewer],
    );
    work.sourceWorks = derived.map((row) => ({
      id: Number(row.id),
      title: row.title,
      author: { id: Number(row.user_id), nickname: row.author_nickname || '匿名' },
    }));
  }

  return work;
}

// ─── 写入 ───

async function assertSourceWork(sourceWorkId, userId) {
  const [rows] = await pool.execute(
    'SELECT id, user_id, is_public, title FROM works WHERE id = ?',
    [sourceWorkId],
  );
  if (rows.length === 0) throw new WorkError(400, '要引用的作品不存在');
  if (!rows[0].is_public && Number(rows[0].user_id) !== Number(userId)) {
    throw new WorkError(400, '无法引用未公开的作品');
  }
  return rows[0];
}

async function findExistingWork(userId, sourceWorkId, digest) {
  // 只做「短时间内的重复提交」去重：同一作品的多次引用应当各产出一件新作品，
  // 所以窗口限定在 5 分钟内，避免把用户有意为之的多次调整合并成一件。
  // digest 不入库：同一份代码的指纹只在查重这一刻需要，运行时计算比对即可。
  const [rows] = await pool.execute(
    `SELECT id FROM works
     WHERE user_id = ?
       AND ((source_work_id IS NULL AND ? IS NULL) OR source_work_id = ?)
       AND updated_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)
       AND SHA2(REGEXP_REPLACE(source_code, '[[:space:]]+', ' '), 256) = ?
     LIMIT 1`,
    [userId, sourceWorkId, sourceWorkId ?? 0, digest],
  );
  return rows.length > 0 ? Number(rows[0].id) : null;
}

/**
 * 创建作品。
 * 幂等：同一用户对同一来源、同一份代码重复提交时，只保留一件（更新 updated_at 后返回原件）。
 */
export async function createWork(userId, {
  title = '',
  description = '',
  sourceCode,
  tags = [],
  // 默认不公开：作品必须由用户手动确认后才出现在广场
  isPublic = false,
  previewImage = null,
  sourceWorkId = null,
  prompt = '',
} = {}) {
  const code = typeof sourceCode === 'string' ? sourceCode.trim() : '';
  if (!code) throw new WorkError(400, '作品源码不能为空');

  const sourceId = Number.isInteger(Number(sourceWorkId)) && Number(sourceWorkId) > 0 ? Number(sourceWorkId) : null;
  let source = null;
  if (sourceId) {
    source = await assertSourceWork(sourceId, userId);
  }

  const digest = digestOf(code);
  const existingId = await findExistingWork(userId, sourceId, digest);
  if (existingId) {
    await pool.execute('UPDATE works SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [existingId]);
    if (sourceId) {
      await recordReference({ sourceWorkId: sourceId, newWorkId: existingId, userId, prompt });
    }
    return getWorkById(existingId, userId, { withSourceWorks: true });
  }

  const finalTitle = truncate(title, 120) || '未命名作品';
  const finalDescription = truncate(description, 1000);

  const [result] = await pool.execute(
    `INSERT INTO works
       (user_id, title, description, source_code, preview_image, tags, is_public,
        source_work_id, origin_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      finalTitle,
      finalDescription,
      code,
      previewImage || null,
      JSON.stringify(normalizeTagList(tags)),
      isPublic === false || isPublic === 0 ? 0 : 1,
      sourceId,
      source ? Number(source.user_id) : null,
    ],
  );

  const newId = Number(result.insertId);
  if (sourceId) {
    await recordReference({ sourceWorkId: sourceId, newWorkId: newId, userId, prompt });
  }

  return getWorkById(newId, userId, { withSourceWorks: true });
}

/** 更新作品（仅作者）。返回 null 表示作品不存在或无权修改。 */
export async function updateWork(id, userId, fields = {}) {
  const workId = Number(id);
  if (!Number.isInteger(workId) || workId <= 0) return null;

  const [rows] = await pool.execute('SELECT user_id FROM works WHERE id = ?', [workId]);
  if (rows.length === 0) return null;
  if (Number(rows[0].user_id) !== Number(userId)) return null;

  const sets = [];
  const params = [];

  if (typeof fields.title === 'string') {
    sets.push('title = ?');
    params.push(truncate(fields.title, 120) || '未命名作品');
  }
  if (typeof fields.description === 'string') {
    sets.push('description = ?');
    params.push(truncate(fields.description, 1000));
  }
  if (fields.tags !== undefined) {
    sets.push('tags = ?');
    params.push(JSON.stringify(normalizeTagList(fields.tags)));
  }
  if (fields.isPublic !== undefined) {
    sets.push('is_public = ?');
    params.push(fields.isPublic === false || fields.isPublic === 0 || fields.isPublic === '0' ? 0 : 1);
  }
  if (typeof fields.sourceCode === 'string' && fields.sourceCode.trim()) {
    sets.push('source_code = ?');
    params.push(fields.sourceCode.trim());
  }

  if (sets.length === 0) {
    return getWorkById(workId, userId, { withSourceWorks: true });
  }

  await pool.execute(`UPDATE works SET ${sets.join(', ')} WHERE id = ?`, [...params, workId]);
  return getWorkById(workId, userId, { withSourceWorks: true });
}

/** 删除作品（仅作者）。收藏与引用流水由外键级联处理。 */
export async function deleteWork(id, userId) {
  const workId = Number(id);
  if (!Number.isInteger(workId) || workId <= 0) return { deleted: false, found: false, owner: false };

  const [rows] = await pool.execute('SELECT user_id FROM works WHERE id = ?', [workId]);
  if (rows.length === 0) return { deleted: false, found: false, owner: false };
  if (Number(rows[0].user_id) !== Number(userId)) return { deleted: false, found: true, owner: false };

  await pool.execute('DELETE FROM works WHERE id = ?', [workId]);
  return { deleted: true, found: true, owner: true };
}

/** 收藏 / 取消收藏（幂等）。返回 null 表示作品对当前用户不可见。 */
export async function toggleFavorite(workId, userId, favorite) {
  const id = Number(workId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const [rows] = await pool.execute(
    'SELECT id FROM works WHERE id = ? AND (is_public = 1 OR user_id = ?)',
    [id, userId],
  );
  if (rows.length === 0) return null;

  if (favorite) {
    await pool.execute(
      'INSERT IGNORE INTO work_favorites (work_id, user_id) VALUES (?, ?)',
      [id, userId],
    );
  } else {
    await pool.execute(
      'DELETE FROM work_favorites WHERE work_id = ? AND user_id = ?',
      [id, userId],
    );
  }

  const [counts] = await pool.execute(
    'SELECT COUNT(*) AS total FROM work_favorites WHERE work_id = ?',
    [id],
  );

  return { favorited: Boolean(favorite), favoriteCount: Number(counts[0].total || 0) };
}

/** 记录一次引用（供"进入调整流程"与"调整产出新作品"两处调用） */
export async function recordReference({ sourceWorkId, newWorkId = null, userId, prompt = '' }) {
  try {
    await pool.execute(
      'INSERT INTO work_references (source_work_id, new_work_id, user_id, prompt) VALUES (?, ?, ?, ?)',
      [sourceWorkId, newWorkId, userId, truncate(prompt, 500)],
    );
    return true;
  } catch (error) {
    console.error('Failed to record work reference:', error.message);
    return false;
  }
}

/** 从对话回复里抽取组件代码：优先取第一个围栏代码块，其次整段（需含 Component 函数） */
export function extractComponentCode(content) {
  if (typeof content !== 'string' || !content.trim()) return null;

  const fenced = content.match(/```(?:tsx?|jsx?|javascript|js)?\s*\n([\s\S]*?)```/);
  if (fenced && fenced[1].trim()) {
    return fenced[1].trim();
  }

  if (/function\s+Component\b/.test(content) || /const\s+Component\b/.test(content)) {
    return content.trim();
  }

  return null;
}

/**
 * 引用调整产出后自动入库：把 AI 的回复抽成组件源码，存成当前用户的新作品。
 * 任何失败都只记日志不抛出 —— 作品入库不能连累用户这轮对话。
 */
export async function createWorkFromChat({
  userId,
  sourceWorkId,
  title = '',
  code,
  prompt = '',
} = {}) {
  try {
    const sourceId = Number(sourceWorkId);
    if (!Number.isInteger(sourceId) || sourceId <= 0) return null;

    const extracted = extractComponentCode(code);
    if (!extracted) {
      console.warn('Skip auto-saving referenced work: no component code found in assistant reply');
      return null;
    }

    const work = await createWork(userId, {
      title: truncate(title, 120) || '引用调整的作品',
      description: truncate(prompt, 1000),
      sourceCode: extracted,
      tags: [],
      // 关键：引用产出一律先存为「仅自己可见」，由用户在界面上手动确认发布
      isPublic: false,
      sourceWorkId: sourceId,
      prompt,
    });

    return work;
  } catch (error) {
    console.error('Failed to auto-save referenced work (chat continues):', error.message);
    return null;
  }
}
