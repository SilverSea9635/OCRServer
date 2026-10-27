import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  WorkError,
  createWork,
  deleteWork,
  getWorkById,
  listWorks,
  recordReference,
  toggleFavorite,
  updateWork,
} from '../services/works.js';

const router = Router();

/**
 * 可选登录：广场是公开页面，游客也要能浏览。
 * 有合法 token 就识别身份（用来算「我收藏过没有」），token 缺失或非法一律按游客放行，
 * 不能像 authMiddleware 那样直接 401。
 */
function optionalAuthMiddleware(req, _res, next) {
  const header = req.headers.authorization;

  if (header && header.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(header.slice(7), JWT_SECRET);
      req.user = { id: payload.id, email: payload.email };
    } catch {
      // 游客视角继续
    }
  }

  next();
}

function parsePage(query) {
  return {
    page: Math.max(1, parseInt(query.page) || 1),
    pageSize: Math.min(50, Math.max(1, parseInt(query.pageSize) || 12)),
  };
}

function handleError(res, error, fallback) {
  if (error instanceof WorkError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  console.error(fallback, error);
  res.status(500).json({ error: fallback });
}

// GET /api/works — 作品列表（游客可访问）
router.get('/', optionalAuthMiddleware, async (req, res) => {
  try {
    const scope = ['public', 'mine', 'favorites'].includes(req.query.scope) ? req.query.scope : 'public';

    if ((scope === 'mine' || scope === 'favorites') && !req.user) {
      res.status(401).json({ error: '未登录，请先登录' });
      return;
    }

    const sort = req.query.sort === 'hot' ? 'hot' : 'latest';
    const { page, pageSize } = parsePage(req.query);

    const result = await listWorks({
      viewerId: req.user?.id ?? null,
      scope,
      sort,
      q: typeof req.query.q === 'string' ? req.query.q : '',
      page,
      pageSize,
    });

    res.json(result);
  } catch (error) {
    handleError(res, error, '获取作品列表失败');
  }
});

// POST /api/works — 创建作品（手动发布）
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { title, description, sourceCode, tags, isPublic, sourceWorkId } = req.body ?? {};
    // sourceWorkId 只能指向"当前用户看得见的作品"，由服务层做可见性校验
    const work = await createWork(req.user.id, {
      title,
      description,
      sourceCode,
      tags,
      isPublic,
      sourceWorkId,
    });
    res.status(201).json({ work });
  } catch (error) {
    handleError(res, error, '创建作品失败');
  }
});

// GET /api/works/mine — 我的作品（含未公开）
router.get('/mine', authMiddleware, async (req, res) => {
  try {
    const { page, pageSize } = parsePage(req.query);
    const result = await listWorks({ viewerId: req.user.id, scope: 'mine', page, pageSize });
    res.json(result);
  } catch (error) {
    handleError(res, error, '获取我的作品失败');
  }
});

// GET /api/works/favorites — 我收藏的作品
router.get('/favorites', authMiddleware, async (req, res) => {
  try {
    const { page, pageSize } = parsePage(req.query);
    const result = await listWorks({ viewerId: req.user.id, scope: 'favorites', page, pageSize });
    res.json(result);
  } catch (error) {
    handleError(res, error, '获取收藏列表失败');
  }
});

// GET /api/works/:id — 作品详情（游客可访问公开作品）
router.get('/:id', optionalAuthMiddleware, async (req, res) => {
  try {
    const work = await getWorkById(req.params.id, req.user?.id ?? null, { withSourceWorks: true });
    if (!work) {
      res.status(404).json({ error: '作品不存在' });
      return;
    }
    res.json({ work });
  } catch (error) {
    handleError(res, error, '获取作品详情失败');
  }
});

// PATCH /api/works/:id — 更新作品（仅作者）
router.patch('/:id', authMiddleware, async (req, res) => {
  try {
    const { title, description, tags, isPublic, sourceCode } = req.body ?? {};

    // 先判存在与归属，才能区分 404 与 403
    const existing = await getWorkById(req.params.id, req.user.id);
    if (!existing) {
      res.status(404).json({ error: '作品不存在' });
      return;
    }
    if (!existing.isOwner) {
      res.status(403).json({ error: '只能修改自己的作品' });
      return;
    }

    const work = await updateWork(req.params.id, req.user.id, { title, description, tags, isPublic, sourceCode });
    res.json({ work });
  } catch (error) {
    handleError(res, error, '更新作品失败');
  }
});

// DELETE /api/works/:id — 删除作品（仅作者）
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const result = await deleteWork(req.params.id, req.user.id);
    if (!result.found) {
      res.status(404).json({ error: '作品不存在' });
      return;
    }
    if (!result.owner) {
      res.status(403).json({ error: '只能删除自己的作品' });
      return;
    }
    res.json({ deleted: true });
  } catch (error) {
    handleError(res, error, '删除作品失败');
  }
});

// POST /api/works/:id/favorite — 收藏
router.post('/:id/favorite', authMiddleware, async (req, res) => {
  try {
    const result = await toggleFavorite(req.params.id, req.user.id, true);
    if (!result) {
      res.status(404).json({ error: '作品不存在' });
      return;
    }
    res.json(result);
  } catch (error) {
    handleError(res, error, '收藏失败');
  }
});

// DELETE /api/works/:id/favorite — 取消收藏（幂等）
router.delete('/:id/favorite', authMiddleware, async (req, res) => {
  try {
    const result = await toggleFavorite(req.params.id, req.user.id, false);
    if (!result) {
      res.status(404).json({ error: '作品不存在' });
      return;
    }
    res.json(result);
  } catch (error) {
    handleError(res, error, '取消收藏失败');
  }
});

// POST /api/works/:id/reference — 记录一次引用（进入调整流程时前端调用）
router.post('/:id/reference', authMiddleware, async (req, res) => {
  try {
    const work = await getWorkById(req.params.id, req.user.id);
    if (!work) {
      res.status(404).json({ error: '作品不存在' });
      return;
    }

    const recorded = await recordReference({
      sourceWorkId: work.id,
      newWorkId: null,
      userId: req.user.id,
      prompt: typeof req.body?.prompt === 'string' ? req.body.prompt : '',
    });

    res.json({ recorded, sourceWorkId: work.id });
  } catch (error) {
    handleError(res, error, '记录引用失败');
  }
});

export default router;
