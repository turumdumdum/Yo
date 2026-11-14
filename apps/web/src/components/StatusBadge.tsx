import type { StageStatus } from '@app/shared';

type Tone = 'approved' | 'waiting' | 'review' | 'idle' | 'rejected';

const TONES: Record<StageStatus, Tone> = {
  'Not started': 'idle',
  'In review': 'review',
  'Waiting for requester': 'waiting',
  Approved: 'approved',
  'Approved with conditions': 'approved',
  Rejected: 'rejected',
  'Not required': 'idle',
};

/** Status is always text plus colour, never colour alone. */
export function StatusBadge({ status }: { status: StageStatus }) {
  return (
    <span className="status-badge" data-tone={TONES[status]}>
      {status}
    </span>
  );
}
