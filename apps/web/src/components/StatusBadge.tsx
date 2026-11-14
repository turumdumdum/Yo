import type { StageStatus } from '@app/shared';
import { Badge, type Tone } from './Badge';

const TONES: Record<StageStatus, Tone> = {
  'Not started': 'idle',
  'In review': 'review',
  'Waiting for requester': 'waiting',
  Approved: 'approved',
  'Approved with conditions': 'approved',
  Rejected: 'rejected',
  'Not required': 'idle',
};

export function StatusBadge({ status }: { status: StageStatus }) {
  return <Badge tone={TONES[status]}>{status}</Badge>;
}
