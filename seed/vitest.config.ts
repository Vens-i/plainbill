import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'seed',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
