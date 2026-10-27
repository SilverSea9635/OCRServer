/**
 * OCRServer 的 PM2 配置：仅管理 Node.js / Express 服务。
 * Python 服务由 Docker 独立管理，通过 AGENT_SERVICE_URL 调用。
 *
 * 用法（在 OCRServer 目录下执行）：
 *   pm2 start ecosystem.config.cjs --env production
 *   pm2 restart ecosystem.config.cjs --env production
 *   pm2 logs snap-ui-server
 *   pm2 save
 */

const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'snap-ui-server',
      cwd: __dirname,
      script: path.join(__dirname, 'server.js'),
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      kill_timeout: 10000,
      // 环境通过 .env.<NODE_ENV> 加载（见 config.js），这里只负责声明 NODE_ENV
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
