import { vitest, describe, it, expect, beforeEach } from 'vitest';
import { AccountSyncWorker } from '../src/auth_sync/account_sync_worker.js';
import { SnapshotClient } from '../src/auth_sync/snapshot_client.js';
import { LocalReplicaWriter } from '../src/auth_sync/local_replica_writer.js';

vitest.mock('../src/auth_sync/snapshot_client.js');
vitest.mock('../src/auth_sync/local_replica_writer.js');

describe('AccountSyncWorker Integration (Dynamic Mock)', () => {
  let worker: AccountSyncWorker;
  let mockClient: any;
  let mockWriter: any;

  beforeEach(() => {
    mockClient = new SnapshotClient() as any;
    mockWriter = new LocalReplicaWriter() as any;
    worker = new AccountSyncWorker();
    (worker as any).snapshotClient = mockClient;
    (worker as any).writer = mockWriter;
  });

  it('should sync users when checksum is valid', async () => {
    const mockUsers = [
      {
        operatorId: 'op1',
        passwordHash: 'hash1',
        role: 'ADMIN',
        active: true,
        updatedAt: '2026-05-29T10:00:00Z'
      }
    ];

    // SHA-256 of JSON.stringify(mockUsers)
    const crypto = await import('node:crypto');
    const checksum = crypto.createHash('sha256').update(JSON.stringify(mockUsers)).digest('hex');

    mockClient.fetchSnapshot.mockResolvedValue({
      version: 10,
      users: mockUsers,
      checksum: checksum
    });

    await worker.runOnce();

    expect(mockWriter.upsertInTransaction).toHaveBeenCalledWith(mockUsers);
    expect((worker as any).lastVersion).toBe(10);
  });

  it('should fail when checksum is invalid', async () => {
    mockClient.fetchSnapshot.mockResolvedValue({
      version: 10,
      users: [],
      checksum: 'invalid-checksum'
    });

    await worker.runOnce();

    expect(mockWriter.upsertInTransaction).not.toHaveBeenCalled();
    expect((worker as any).attempt).toBe(1);
  });
});
