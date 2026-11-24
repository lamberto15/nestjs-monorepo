import { deleteInBatches } from './batches.js';

describe('deleteInBatches', () => {
  it('deletes until a batch comes back short, and adds them up', async () => {
    const answers = [3, 3, 1];
    const batch = vi.fn(async (limit: number) => {
      expect(limit).toBe(3);
      return answers.shift()!;
    });
    expect(await deleteInBatches(batch, 3)).toBe(7);
    expect(batch).toHaveBeenCalledTimes(3);
  });

  it('stops after one empty batch', async () => {
    const batch = vi.fn(async () => 0);
    expect(await deleteInBatches(batch)).toBe(0);
    expect(batch).toHaveBeenCalledTimes(1);
  });
});
