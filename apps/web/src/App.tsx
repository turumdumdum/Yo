import { DEFAULT_STAGES } from '@app/shared';
import { StatusBadge } from './components/StatusBadge';

// Placeholder shell until sign-in and organizations land (Stage 1, step 1).
export function App() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <span className="brand">[Product name]</span>
      </header>
      <main id="main" className="page">
        <h1>Vendor intake and due diligence</h1>
        <p className="lead">
          This is the project scaffold. Sign-in, the request form and the tracker are not built yet.
        </p>
        <section className="card" aria-labelledby="stages-heading">
          <h2 id="stages-heading">Default review stages</h2>
          <ul className="stage-list">
            {DEFAULT_STAGES.map((stage) => (
              <li key={stage}>
                <span>{stage}</span>
                <StatusBadge status="Not started" />
              </li>
            ))}
          </ul>
        </section>
      </main>
    </>
  );
}
