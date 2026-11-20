import type { ReactNode } from 'react';

/** Text with https links turned into links. Everything else stays plain text. */
function withLinks(text: string): ReactNode[] {
  const parts = text.split(/(https:\/\/[^\s)]+)/g);
  return parts.map((part, i) =>
    /^https:\/\/[^\s)]+$/.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer">
        {part}
      </a>
    ) : (
      part
    ),
  );
}

/**
 * Renders a review guide written by an admin: "## " headings, "- " list items, other lines
 * as paragraphs. Built from React elements only, so no markup in the text can run.
 */
export function Guide({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length > 0) {
      blocks.push(
        <ul key={`l${blocks.length}`}>
          {list.map((item, i) => (
            <li key={i}>{withLinks(item)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('- ')) {
      list.push(line.slice(2));
      continue;
    }
    flush();
    if (line === '') continue;
    if (line.startsWith('## ')) blocks.push(<h4 key={`h${blocks.length}`}>{line.slice(3)}</h4>);
    else blocks.push(<p key={`p${blocks.length}`}>{withLinks(line)}</p>);
  }
  flush();
  return <div className="review-guide">{blocks}</div>;
}
