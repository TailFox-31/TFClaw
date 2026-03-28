import { describe, expect, it } from 'vitest';

import { buildRoomRoleContext } from './room-role-context.js';

describe('buildRoomRoleContext', () => {
  it('returns reviewer context for a normal paired codex turn', () => {
    expect(
      buildRoomRoleContext(
        {
          chat_jid: 'group@test',
          owner_service_id: 'claude',
          reviewer_service_id: 'codex-main',
          activated_at: null,
          reason: null,
          explicit: false,
        },
        'codex-main',
      ),
    ).toEqual({
      serviceId: 'codex-main',
      role: 'reviewer',
      ownerServiceId: 'claude',
      reviewerServiceId: 'codex-main',
      failoverOwner: false,
    });
  });

  it('returns owner failover context for a codex-review failover turn', () => {
    expect(
      buildRoomRoleContext(
        {
          chat_jid: 'group@test',
          owner_service_id: 'codex-review',
          reviewer_service_id: 'codex-main',
          activated_at: '2026-03-28T10:00:00.000Z',
          reason: 'claude-429',
          explicit: true,
        },
        'codex-review',
      ),
    ).toEqual({
      serviceId: 'codex-review',
      role: 'owner',
      ownerServiceId: 'codex-review',
      reviewerServiceId: 'codex-main',
      failoverOwner: true,
    });
  });

  it('returns undefined for a non-paired room', () => {
    expect(
      buildRoomRoleContext(
        {
          chat_jid: 'solo@test',
          owner_service_id: 'codex-main',
          reviewer_service_id: null,
          activated_at: null,
          reason: null,
          explicit: false,
        },
        'codex-main',
      ),
    ).toBeUndefined();
  });
});
