// Product vocabulary. Values are the English labels shown in the UI (CLAUDE.md §1, §5, §6, §8).

export const ORG_ROLES = [
  'org_admin',
  'process_manager',
  'reviewer',
  'requester',
  'owner',
  'auditor',
] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const ORG_ROLE_LABELS: Record<OrgRole, string> = {
  org_admin: 'Org admin',
  process_manager: 'Process manager',
  reviewer: 'Reviewer',
  requester: 'Requester',
  owner: 'Owner',
  auditor: 'Auditor',
};

export const REQUEST_TYPES = ['New vendor', 'New service', 'Renewal', 'Change of scope'] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

export const DATA_CLASSIFICATIONS = ['Public', 'Internal', 'Confidential', 'Restricted'] as const;
export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];

export const BUSINESS_CRITICALITIES = ['Low', 'Medium', 'High', 'Critical'] as const;
export type BusinessCriticality = (typeof BUSINESS_CRITICALITIES)[number];

export const RISK_TIERS = ['Low', 'Medium', 'High', 'Critical'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

export const PAYMENT_TYPES = ['Free', 'Trial', 'Paid'] as const;
export type PaymentType = (typeof PAYMENT_TYPES)[number];

export const STAGE_STATUSES = [
  'Not started',
  'In review',
  'Waiting for requester',
  'Approved',
  'Approved with conditions',
  'Rejected',
  'Not required',
] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const DEFAULT_STAGES = [
  'License check',
  'Security review',
  'Legal review',
  'Finance review',
  'IT review',
] as const;
