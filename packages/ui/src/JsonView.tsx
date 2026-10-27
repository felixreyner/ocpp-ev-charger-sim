import { Fragment } from 'react';

/** Tiny syntax highlighter for JSON payloads. */
export function JsonView({ value }: { value: unknown }) {
  const text = JSON.stringify(value, null, 2) ?? 'undefined';
  const parts = text.split(/("(?:\\.|[^"\\])*"(?:\s*:)?|\b-?\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|\btrue\b|\bfalse\b|\bnull\b)/g);
  return (
    <pre className="json">
      {parts.map((p, i) => {
        if (i % 2 === 0) return <Fragment key={i}>{p}</Fragment>;
        let cls = 'j-num';
        if (p.startsWith('"')) cls = p.trimEnd().endsWith(':') ? 'j-key' : 'j-str';
        else if (p === 'true' || p === 'false') cls = 'j-bool';
        else if (p === 'null') cls = 'j-null';
        return (
          <span key={i} className={cls}>
            {p}
          </span>
        );
      })}
    </pre>
  );
}
