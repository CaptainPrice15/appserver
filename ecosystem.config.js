module.exports = {
  apps: [{
    name: 'stealth-chat-server',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '450M',
    env: {
      NODE_ENV: 'production',
      PORT: 8080
    }
  }]
};
