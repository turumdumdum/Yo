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

const REQUEST_STATUS: Record<string, { tone: Tone; label: string }> = {
  draft: { tone: 'idle', label: 'Draft' },
  submitted: { tone: 'review', label: 'Submitted' },
  in_review: { tone: 'review', label: 'In review' },
  approved: { tone: 'approved', label: 'Approved' },
  rejected: { tone: 'rejected', label: 'Rejected' },
};

export function RequestStatusBadge({ status }: { status: string }) {
  const { tone, label } = REQUEST_STATUS[status] ?? { tone: 'idle' as const, label: status };
  return <Badge tone={tone}>{label}</Badge>;
}
