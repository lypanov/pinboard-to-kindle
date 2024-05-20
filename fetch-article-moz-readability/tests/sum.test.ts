// sum.test.ts
import { sum } from '../src/sum';
// @ts-ignore
import { main } from '../ft.js';

test('adds 1 + 2 to equal 3', async () => {
  await main();
  expect(sum(1, 2)).toBe(3);
});

