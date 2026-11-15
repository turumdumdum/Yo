import { useId, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { answerInfoRequest, askRequester, type InfoRequest } from './api';

const formatDateTime = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

/** Questions and answers of one stage, oldest first. */
export function QuestionThread({ questions, nameOf }: { questions: InfoRequest[]; nameOf: (userId: string | null) => string }) {
  if (questions.length === 0) return null;
  return (
    <ul className="thread">
      {questions.map((q) => (
        <li key={q.id}>
          <p className="thread-meta">
            {nameOf(q.asked_by)} asked on {formatDateTime(q.asked_at)}
          </p>
          <p className="thread-text">{q.question}</p>
          {q.answer ? (
            <>
              <p className="thread-meta">Requester answered on {formatDateTime(q.answered_at!)}</p>
              <p className="thread-text thread-answer">{q.answer}</p>
            </>
          ) : (
            <p className="thread-meta">Waiting for the requester’s answer.</p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Reviewer: ask the requester a question. Pauses the stage's SLA clock until it is answered. */
export function AskForm({ supabase, stageId, onAsked }: { supabase: SupabaseClient; stageId: string; onAsked: () => Promise<void> | void }) {
  const id = useId();
  const [question, setQuestion] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function ask() {
    if (question.trim() === '') {
      setError('Write a question.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await askRequester(supabase, stageId, question);
      setQuestion('');
      await onAsked();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field">
      <label htmlFor={id}>Ask the requester a question</label>
      <p id={`${id}-hint`} className="field-hint">
        The stage waits for the requester and its SLA clock stops until they answer.
      </p>
      <textarea id={id} aria-describedby={`${id}-hint`} rows={2} maxLength={2000} value={question} onChange={(e) => setQuestion(e.target.value)} />
      <FormError message={error} />
      <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => void ask()}>
        {busy ? 'Sending…' : 'Send question'}
      </button>
    </div>
  );
}

interface AnswerProps {
  supabase: SupabaseClient;
  questions: InfoRequest[];
  stageName: (stageId: string) => string;
  nameOf: (userId: string | null) => string;
  onAnswered: () => Promise<void> | void;
}

/** Requester: the banner with every open question on this request. */
export function ActionRequired({ supabase, questions, stageName, nameOf, onAnswered }: AnswerProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function send(q: InfoRequest) {
    const text = (answers[q.id] ?? '').trim();
    if (text === '') {
      setError('Write an answer.');
      return;
    }
    setBusy(q.id);
    setError(null);
    try {
      await answerInfoRequest(supabase, q.id, text);
      await onAnswered();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="action-required" aria-labelledby="action-heading">
      <h2 id="action-heading">Action required from you</h2>
      <p>
        {questions.length === 1 ? 'A reviewer has a question.' : `Reviewers have ${questions.length} questions.`} The review of
        that stage waits until you answer.
      </p>
      <FormError message={error} />
      {questions.map((q) => (
        <div key={q.id} className="action-question">
          <p className="thread-meta">
            {stageName(q.stage_id)} · {nameOf(q.asked_by)}
          </p>
          <p className="thread-text">{q.question}</p>
          <label htmlFor={`answer-${q.id}`}>Your answer</label>
          <textarea
            id={`answer-${q.id}`}
            rows={3}
            maxLength={4000}
            value={answers[q.id] ?? ''}
            onChange={(e) => setAnswers((current) => ({ ...current, [q.id]: e.target.value }))}
          />
          <button type="button" className="button button-small" disabled={busy !== null} onClick={() => void send(q)}>
            {busy === q.id ? 'Sending…' : 'Send answer'}
          </button>
        </div>
      ))}
    </section>
  );
}
