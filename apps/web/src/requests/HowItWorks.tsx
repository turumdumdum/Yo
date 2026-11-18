/** Plain-language explanation of the process, for people who have never used the app. */
export function HowItWorks({ compact = false }: { compact?: boolean }) {
  return (
    <section className={`how-it-works${compact ? ' compact' : ''}`} aria-labelledby="how-heading">
      <h2 id="how-heading">How it works</h2>
      <ol className="how-steps">
        <li>
          <span className="how-number" aria-hidden="true">
            1
          </span>
          <span>
            <strong>Describe what you need.</strong> Answer a few questions about the service and the vendor. It takes about ten
            minutes, and your answers are saved as you go.
          </span>
        </li>
        <li>
          <span className="how-number" aria-hidden="true">
            2
          </span>
          <span>
            <strong>Reviewers check it.</strong> Security, legal, finance and IT look at the parts that concern them. If they have a
            question, you will see it here.
          </span>
        </li>
        <li>
          <span className="how-number" aria-hidden="true">
            3
          </span>
          <span>
            <strong>You get a decision.</strong> When all checks are done the request is approved or not, with the reasons.
          </span>
        </li>
      </ol>
    </section>
  );
}
