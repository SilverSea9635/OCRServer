import { Router } from 'express';
import { pool } from '../config.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

// GET /api/credits/balance
router.get('/balance', authMiddleware, async (req, res) => {
  const [rows] = await pool.execute('SELECT credits FROM users WHERE id = ?', [req.user.id]);

  if (!rows.length) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }

  res.json({ balance: rows[0].credits });
});

// POST /api/credits/deduct
router.post('/deduct', authMiddleware, async (req, res) => {
  const { amount, description } = req.body ?? {};

  if (!amount || typeof amount !== 'number' || amount <= 0) {
    res.status(400).json({ error: '扣减积分数量必须为正数' });
    return;
  }

  const [rows] = await pool.execute('SELECT credits FROM users WHERE id = ?', [req.user.id]);
  const user = rows[0];
  if (!user) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }

  if (user.credits < amount) {
    res.status(400).json({ error: '积分不足', balance: user.credits });
    return;
  }

  const newBalance = user.credits - amount;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute("UPDATE users SET credits = ? WHERE id = ?", [newBalance, req.user.id]);
    await conn.execute(
      'INSERT INTO credit_transactions (user_id, type, amount, balance, description) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, 'deduct', amount, newBalance, description || 'AI 组件生成']
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  res.json({ balance: newBalance });
});

// GET /api/credits/packages
router.get('/packages', (_req, res) => {
  const packages = [
    { id: 'basic', name: '基础包', credits: 100, price: 9.9, description: '适合轻度使用' },
    { id: 'standard', name: '标准包', credits: 500, price: 39.9, description: '性价比之选' },
    { id: 'premium', name: '高级包', credits: 1200, price: 79.9, description: '重度用户首选' },
    { id: 'unlimited', name: '无限包', credits: 5000, price: 299.9, description: '企业/团队使用' },
  ];

  res.json(packages);
});

// GET /api/credits/transactions
router.get('/transactions', authMiddleware, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = 20;
  const offset = (page - 1) * pageSize;

  const [countRows] = await pool.execute(
    'SELECT COUNT(*) as count FROM credit_transactions WHERE user_id = ?',
    [req.user.id]
  );
  const total = countRows[0].count;

  const [data] = await pool.query(
    'SELECT * FROM credit_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [req.user.id, pageSize, offset]
  );

  res.json({ data, total, page, pageSize });
});

export default router;