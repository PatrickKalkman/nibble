// ecosystem.config.cjs
// Note: Use .cjs extension for CommonJS in an ES module project

module.exports = {
    apps: [{
      name: 'nibble',
      script: './src/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_file: './logs/combined.log',
      time: true,
      // Add these for ES modules support
      interpreter_args: '--experimental-specifier-resolution=node',
      node_args: '--experimental-specifier-resolution=node'
    }]
  };