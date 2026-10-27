import {cleanupUnusedAttachments} from '../services/attachments.js';
import {pool} from '../config.js';
try { console.log(`已清理 ${await cleanupUnusedAttachments()} 个超过 24 小时且未被消息引用的图片`); }
finally {await pool.end();}
