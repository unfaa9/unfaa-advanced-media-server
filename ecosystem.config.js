// PM2: pm2 start ecosystem.config.js --env production
// Fork mode with ONE instance: rate limits, idempotency locks and variant de-duplication are
// in-process. Scaling out needs shared storage and shared locks first.
module.exports = {
  apps: [
    {
      name: 'media-server',
      script: 'dist/server.js',
      exec_mode: 'fork',
      instances: 1,
      kill_timeout: 30000, // graceful shutdown drains for up to 25 s
      max_memory_restart: '1500M',
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
