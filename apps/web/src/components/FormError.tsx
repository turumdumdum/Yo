/** Announced to screen readers as soon as it appears. */
export function FormError({ message }: { message: string | null }) {
  return (
    <div role="alert" className={message ? 'form-error' : undefined}>
      {message}
    </div>
  );
}
