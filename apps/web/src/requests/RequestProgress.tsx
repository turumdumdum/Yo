import type { InfoRequest, RequestRow, StageRow } from './api';

const DONE = new Set(['Approved', 'Approved with conditions', 'Rejected']);
const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });

interface Props {
  request: RequestRow;
  stages: StageRow[] | null;
  questions: InfoRequest[];
  /** Whether the person looking is the one who asked for the service. */
  isRequester: boolean;
}

type State = 'done' | 'current' | 'todo';

/** Where the request is, in three plain steps, and what happens next. */
export function RequestProgress({ request, stages, questions, isRequester }: Props) {
  const required = (stages ?? []).filter((s) => s.status !== 'Not required');
  const done = required.filter((s) => DONE.has(s.status)).length;
  const waiting = questions.some((q) => q.answered_at === null);
  const decided = request.status === 'approved' || request.status === 'rejected';

  const items: { title: string; detail: string; state: State }[] = [
    { title: 'Sent', detail: request.submitted_at ? formatDate(request.submitted_at) : '', state: 'done' },
    {
      title: 'Checks',
      detail: waiting
        ? isRequester
          ? 'Waiting for your answer'
          : 'Waiting for the requester'
        : required.length > 0
          ? `${done} of ${required.length} done`
          : 'Starting',
      state: decided ? 'done' : 'current',
    },
    {
      title: 'Decision',
      detail: request.status === 'approved' ? 'Approved' : request.status === 'rejected' ? 'Not approved' : 'After all checks',
      state: decided ? 'done' : 'todo',
    },
  ];

  let next: string;
  if (request.status === 'approved') next = 'The request is approved. Follow any conditions shown in the checks below.';
  else if (request.status === 'rejected') next = 'The request was not approved. The reasons are in the checks below; you can start a new request with changes.';
  else if (waiting && isRequester) next = 'A reviewer asked you a question. Answer it above so the check can continue.';
  else if (isRequester) next = 'Reviewers are checking your request. You do not need to do anything unless a question appears here.';
  else next = 'Open a check below to see its details or to review it.';

  return (
    <section className={`progress-panel${decided ? ` decided-${request.status}` : ''}`} aria-label="Progress">
      <ol className="progress-steps">
        {items.map((item, i) => (
          <li key={item.title} data-state={item.state} aria-current={item.state === 'current' ? 'step' : undefined}>
            <span className="progress-dot" aria-hidden="true">
              {item.state === 'done' ? '✓' : i + 1}
            </span>
            <span className="progress-label">
              <strong>{item.title}</strong>
              <span>{item.detail}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="progress-next">{next}</p>
    </section>
  );
}
