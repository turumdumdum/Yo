export type Tone = 'approved' | 'waiting' | 'review' | 'idle' | 'rejected';

/** Status is always text plus colour, never colour alone. */
export function Badge({ tone, children }: { tone: Tone; children: string }) {
  return (
    <span className="status-badge" data-tone={tone}>
      {children}
    </span>
  );
}

const RISK_TONES: Record<string, Tone> = { Low: 'approved', Medium: 'review', High: 'waiting', Critical: 'rejected' };

export function RiskBadge({ tier }: { tier: string }) {
  return <Badge tone={RISK_TONES[tier] ?? 'idle'}>{`${tier} risk`}</Badge>;
}

export function RequestStatusBadge({ status }: { status: 'draft' | 'submitted' | 'in_review' }) {
  if (status === 'draft') return <Badge tone="idle">Draft</Badge>;
  return <Badge tone="review">{status === 'in_review' ? 'In review' : 'Submitted'}</Badge>;
}
