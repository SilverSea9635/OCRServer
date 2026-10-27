import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { ModelProfileError, listModelProfiles, saveModelProfile, deleteModelProfile } from '../services/modelProfiles.js';
const router = Router();
router.use(authMiddleware);
const handle = (action) => async (req, res) => {
  try { await action(req, res); }
  catch (error) { res.status(error instanceof ModelProfileError ? error.status : 500).json({ error: error instanceof ModelProfileError ? error.message : '模型配置操作失败' }); }
};
router.get('/', handle(async (req, res) => res.json({ profiles: await listModelProfiles(req.user.id) })));
router.post('/', handle(async (req, res) => res.status(201).json({ profile: await saveModelProfile(req.user.id, req.body || {}) })));
router.put('/:id', handle(async (req, res) => res.json({ profile: await saveModelProfile(req.user.id, req.body || {}, req.params.id) })));
router.delete('/:id', handle(async (req, res) => { await deleteModelProfile(req.user.id, req.params.id); res.json({ deleted: true }); }));
export default router;
