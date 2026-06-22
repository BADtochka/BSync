module.exports = {
  apps: [
    {
      name: 'sync-server',
      cwd: './apps/sync-server',
      script: 'src/index.ts',
      interpreter: `${process.env.HOME}/.bun/bin/bun`,
      interpreter_args: '--watch src/index.ts ../../packages/sync-protocol/src/index.ts',
      env: {
        PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
      },
    },
  ],
};
