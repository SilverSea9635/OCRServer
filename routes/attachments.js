import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { AttachmentError, uploadAttachment, attachmentView, deleteUnusedAttachment } from '../services/attachments.js';

const router = Router();
router.use(authMiddleware);
const handle = action => async (req, res) => {
  try {
    await action(req, res);
  } catch ( error ) {
    res.status(error instanceof AttachmentError ? error.statusCode : 500).json({ error: error instanceof AttachmentError ? error.message : '附件操作失败' });
  }
};
router.post('/', handle(async (req, res) => {
  res.status(201).json({ attachment: await uploadAttachment(req.user.id, req.body || {}) });
}));
router.get('/:id', handle(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ attachment: await attachmentView(req.user.id, req.params.id) });
}));
router.delete('/:id', handle(async (req, res) => {
  await deleteUnusedAttachment(req.user.id, req.params.id);
  res.json({ deleted: true });
}));
export default router;
