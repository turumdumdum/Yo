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

export function RequestStatusBadge({ status }: { status: 'draft' | 'submitted' }) {
  return status === 'draft' ? <Badge tone="idle">Draft</Badge> : <Badge tone="review">Submitted</Badge>;
}
