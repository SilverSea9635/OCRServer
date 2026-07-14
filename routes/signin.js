import { Router } from 'express';
import { pool } from '../config.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

// 7-day repeating reward schedule
const REWARDS = [5, 5, 5, 10, 10, 10, 20];

function getReward(consecutiveDays) {
  const index = (consecutiveDays - 1) % REWARDS.length;
  return REWARDS[index];
}

// GET /api/signin/status
router.get('/status', authMiddleware, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  const [todayRows] = await pool.execute(
    'SELECT id FROM user_sign_ins WHERE user_id = ? AND sign_date = ?',
    [req.user.id, today]
  );
  const signedToday = todayRows.length > 0;

  // Get yesterday's record to determine consecutive days
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const [yesterdayRows] = await pool.execute(
    'SELECT consecutive_days FROM user_sign_ins WHERE user_id = ? AND sign_date = ?',
    [req.user.id, yesterday]
  );

  let consecutiveDays = 0;
  if (signedToday) {
    const [todayRecord] = await pool.execute(
      'SELECT consecutive_days FROM user_sign_ins WHERE user_id = ? AND sign_date = ?',
      [req.user.id, today]
    );
    consecutiveDays = todayRecord[0].consecutive_days;
  } else if (yesterdayRows.length > 0) {
    consecutiveDays = yesterdayRows[0].consecutive_days; // will be +1 on sign-in
  }

  const nextDay = signedToday ? consecutiveDays : consecutiveDays + 1;
  const nextReward = getReward(nextDay);

  res.json({ signedToday, consecutiveDays, nextReward });
});

// POST /api/signin
router.post('/', authMiddleware, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  // Check if already signed today
  const [existing] = await pool.execute(
    'SELECT id FROM user_sign_ins WHERE user_id = ? AND sign_date = ?',
    [req.user.id, today]
  );
  if (existing.length > 0) {
    res.status(400).json({ error: '今日已签到' });
    return;
  }

  // Check yesterday's record for consecutive days
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const [yesterdayRows] = await pool.execute(
    'SELECT consecutive_days FROM user_sign_ins WHERE user_id = ? AND sign_date = ?',
    [req.user.id, yesterday]
  );

  const consecutiveDays = yesterdayRows.length > 0 ? yesterdayRows[0].consecutive_days + 1 : 1;
  const reward = getReward(consecutiveDays);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Get current balance
    const [userRows] = await conn.execute('SELECT credits FROM users WHERE id = ?', [req.user.id]);
    if (!userRows.length) {
      await conn.rollback();
      res.status(404).json({ error: '用户不存在' });
      return;
    }

    const newBalance = userRows[0].credits + reward;

    // Update credits
    await conn.execute('UPDATE users SET credits = ? WHERE id = ?', [newBalance, req.user.id]);

    // Insert sign-in record
    await conn.execute(
      'INSERT INTO user_sign_ins (user_id, sign_date, consecutive_days, reward) VALUES (?, ?, ?, ?)',
      [req.user.id, today, consecutiveDays, reward]
    );

    // Insert credit transaction
    await conn.execute(
      'INSERT INTO credit_transactions (user_id, type, amount, balance, description) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, 'gift', reward, newBalance, `连续签到第${consecutiveDays}天`]
    );

    await conn.commit();
    res.json({ consecutiveDays, reward, balance: newBalance });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

export default router;