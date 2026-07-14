import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool, INITIAL_CREDITS } from '../config.js';
import { signToken, signRefreshToken, verifyRefreshToken, authMiddleware } from '../middleware/auth.js';

const router = Router();

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { email, password, nickname } = req.body ?? {};

  if (!email || !password || !nickname) {
    res.status(400).json({ error: '邮箱、密码和昵称不能为空' });
    return;
  }

  if (typeof email !== 'string' || !email.includes('@')) {
    res.status(400).json({ error: '邮箱格式不正确' });
    return;
  }

  if (typeof password !== 'string' || password.length < 6) {
    res.status(400).json({ error: '密码至少 6 位' });
    return;
  }

  const [existing] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
  if (existing.length) {
    res.status(409).json({ error: '该邮箱已注册' });
    return;
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const initialCredits = INITIAL_CREDITS;

  const [result] = await pool.execute(
    'INSERT INTO users (email, password, nickname, credits) VALUES (?, ?, ?, ?)',
    [email, hashedPassword, nickname, initialCredits]
  );

  const [rows] = await pool.execute(
    'SELECT id, email, nickname, credits, created_at FROM users WHERE id = ?',
    [result.insertId]
  );
  const user = rows[0];

  // Record initial credits transaction
  await pool.execute(
    'INSERT INTO credit_transactions (user_id, type, amount, balance, description) VALUES (?, ?, ?, ?, ?)',
    [user.id, 'gift', initialCredits, initialCredits, '新用户注册赠送']
  );

  const token = signToken(user);
  const refreshToken = signRefreshToken(user);

  res.status(201).json({ token, refreshToken, user });
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};

  if (!email || !password) {
    res.status(400).json({ error: '邮箱和密码不能为空' });
    return;
  }

  const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
  const user = rows[0];
  if (!user) {
    res.status(401).json({ error: '该邮箱暂未注册，请注册后再使用' });
    return;
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    res.status(401).json({ error: '邮箱或密码错误' });
    return;
  }

  const token = signToken(user);
  const refreshToken = signRefreshToken(user);
  const { password: _, ...safeUser } = user;

  res.json({ token, refreshToken, user: safeUser });
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res) => {
  const [rows] = await pool.execute(
    'SELECT id, email, nickname, avatar, credits, created_at FROM users WHERE id = ?',
    [req.user.id]
  );

  if (!rows.length) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }

  res.json(rows[0]);
});

// PUT /api/auth/profile
router.put('/profile', authMiddleware, async (req, res) => {
  const { nickname, avatar, currentPassword, newPassword } = req.body ?? {};

  // Password change
  if (newPassword) {
    if (!currentPassword) {
      res.status(400).json({ error: '请输入当前密码' });
      return;
    }

    if (typeof newPassword !== 'string' || newPassword.length < 6) {
      res.status(400).json({ error: '新密码至少 6 位' });
      return;
    }

    const [userRows] = await pool.execute('SELECT password FROM users WHERE id = ?', [req.user.id]);
    if (!userRows.length) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }

    const valid = await bcrypt.compare(currentPassword, userRows[0].password);
    if (!valid) {
      res.status(401).json({ error: '当前密码错误' });
      return;
    }

    const hashedNew = await bcrypt.hash(newPassword, 10);
    await pool.execute('UPDATE users SET password = ? WHERE id = ?', [hashedNew, req.user.id]);
  }

  // Profile fields update
  const fields = [];
  const values = [];

  if (nickname !== undefined && nickname !== null) {
    if (typeof nickname !== 'string' || nickname.trim().length === 0) {
      res.status(400).json({ error: '昵称不能为空' });
      return;
    }
    fields.push('nickname = ?');
    values.push(nickname.trim());
  }
  if (avatar !== undefined) {
    fields.push('avatar = ?');
    values.push(avatar || null);
  }

  if (fields.length) {
    values.push(req.user.id);
    await pool.execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
  }

  const [rows] = await pool.execute(
    'SELECT id, email, nickname, avatar, credits, created_at FROM users WHERE id = ?',
    [req.user.id]
  );
  res.json(rows[0]);
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body ?? {};

  if (!refreshToken) {
    res.status(400).json({ error: 'refreshToken 不能为空' });
    return;
  }

  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    res.status(401).json({ error: 'Refresh token 无效或已过期，请重新登录' });
    return;
  }

  // Verify user still exists
  const [rows] = await pool.execute(
    'SELECT id, email, nickname, credits FROM users WHERE id = ?',
    [payload.id]
  );

  if (!rows.length) {
    res.status(401).json({ error: '用户不存在，请重新登录' });
    return;
  }

  const user = rows[0];
  const token = signToken(user);
  const newRefreshToken = signRefreshToken(user);

  res.json({ token, refreshToken: newRefreshToken });
});

export default router;