import { useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { deleteForever, setArchived, setTrashed, type RequestRow } from './api';
import type { ReviewContext } from './StagePanel';

const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });

interface Props {
  supabase: SupabaseClient;
  request: RequestRow;
  context: ReviewContext;
  onChanged: () => Promise<void> | void;
  /** Called after the request was deleted for good. */
  onDeleted: () => void;
}

/**
 * Archive, trash and permanent deletion of a decided request. Everyone sees whether it is
 * archived; only org admins see the actions (and the database allows them only to them).
 */
export function Lifecycle({ supabase, request, context, onChanged, onDeleted }: Props) {
  const isAdmin = context.members.some((m) => m.user_id === context.userId && m.role === 'org_admin');
  const decided = request.status === 'approved' || request.status === 'rejected';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = request.service_name || 'this request';

  if (!decided || (!isAdmin && !request.archived_at)) return null;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const inTrash = request.deleted_at !== null;
  const archived = request.archived_at !== null;

  return (
    <section className={`card lifecycle-banner${inTrash ? ' in-trash' : ''}`} aria-labelledby="lifecycle-heading">
      <h2 id="lifecycle-heading">{inTrash ? 'In the trash' : archived ? 'Archived' : 'Archive or delete'}</h2>
      <p>
        {inTrash
          ? `Moved to the trash on ${formatDate(request.deleted_at!)}. Only org admins can see it. Restore it, or delete it for good with its files.`
          : archived
            ? `Archived on ${formatDate(request.archived_at!)}. It is kept for the record and no longer shown with active vendors.`
            : 'Archive a vendor you no longer use to keep it for the record, or move it to the trash. Only org admins can do this.'}
      </p>
      <FormError message={error} />
      {isAdmin && (
        <div className="form-actions">
          {inTrash ? (
            <>
              <button type="button" className="button" disabled={busy} onClick={() => void run(() => setTrashed(supabase, request.id, false))}>
                Restore from the trash
              </button>
              <button
                type="button"
                className="button button-danger"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm(`Delete “${name}” for good? Its checks, questions and files are removed. This cannot be undone.`)) return;
                  void run(async () => {
                    const result = await deleteForever(supabase, request.id);
                    if (!result.filesRemoved) window.alert('The request is deleted. Some files could not be removed from storage; the server log has the details.');
                    onDeleted();
                  });
                }}
              >
                Delete for good
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="button button-secondary"
                disabled={busy}
                onClick={() => void run(() => setArchived(supabase, request.id, !archived))}
              >
                {archived ? 'Restore from the archive' : 'Archive'}
              </button>
              <button
                type="button"
                className="button button-secondary"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`Move “${name}” to the trash? Only org admins will see it until it is restored.`)) {
                    void run(() => setTrashed(supabase, request.id, true));
                  }
                }}
              >
                Move to the trash
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
