import type { Toast } from './useLiveSocket.ts';

export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.level}`}>
          <span className="toast-dot" />
          {t.text}
        </div>
      ))}
    </div>
  );
}
