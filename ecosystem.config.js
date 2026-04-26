module.exports = {
  name: 'sync-server',
  script: './scripts/sync-server.js',
  interpreter: `${process.env.HOME}/.bun/bin/bun`,
  env: {
    PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
  },
};
