import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import CloudC from '../src/cloudC.js';
import { createLandCloudProvider } from '../src/adapters/landcloud.js';

test('LandCloud keeps CloudC records and expiry across database reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'endgo-landcloud-'));
  const path = join(directory, 'storage.sqlite');
  const value = { name: 'portable', updated: new Date(0), count: 12n };
  let now = 1000;

  try {
    {
      using first = new Database(path);
      const provider = createLandCloudProvider(first, { now: () => now });
      expect(provider.id).toBe('landcloud');
      const cloud = new CloudC({ provider });
      await cloud.Write('record:one', value, { ttl: 10 });
      await cloud.Write('record:two', value);
    }

    using reopened = new Database(path);
    const resumed = new CloudC({ provider: createLandCloudProvider(reopened, { now: () => now }) });
    expect(await resumed.Read('record:one')).toEqual(value);
    now += 11;
    expect(await resumed.Read('record:one')).toBeUndefined();
    expect(await resumed.Read('record:two')).toEqual(value);
    await resumed.Delete('record:two');
    expect(await resumed.Read('record:two')).toBeUndefined();
    await expect(resumed.Write('record:global', value, { global: true })).rejects.toThrow(/global/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
