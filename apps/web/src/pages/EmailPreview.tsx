/**
 * Staff view of the patient's bill email (artboard 1d): the logged email once sent, or a live
 * render of the current draft. Links open in a new tab, so staff can walk the patient's path.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { EmailPreview as Preview } from '@plainbill/api/contract';
import { api, ApiError } from '../lib/api';

function deliveryNote(p: Preview): string {
  if (p.kind === 'draft') return 'Preview of the draft — not sent yet.';
  if (p.status === 'outbox')
    return 'Kept in the outbox: no email provider is set (RESEND_API_KEY).';
  if (p.status === 'failed') return `Email failed: ${p.error ?? 'unknown error'}`;
  return `Delivered by ${p.provider === 'resend' ? 'Resend' : 'email'}.`;
}

export function EmailPreview() {
  const { id = '' } = useParams();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(900);

  useEffect(() => {
    api
      .emailPreview(Number(id))
      .then(setPreview)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Could not load.'));
  }, [id]);

  // Links in the email open in a new tab instead of inside the frame.
  const srcDoc = preview?.html.replace('<head>', '<head><base target="_blank">');

  return (
    <div className="email-page">
      <div className="email-page-head">
        <Link to="/dashboard" className="pb-back">
          ← Dashboard
        </Link>
        {preview && (
          <>
            <h1>Email to {preview.patientName}</h1>
            <dl className="email-page-meta">
              <dt>Subject</dt>
              <dd>{preview.subject}</dd>
              <dt>To</dt>
              <dd>{preview.to}</dd>
            </dl>
            <p className={`email-page-status is-${preview.status}`}>{deliveryNote(preview)}</p>
            <div className="email-page-actions">
              {preview.payPath && (
                <a className="btn" href={preview.payPath} target="_blank" rel="noreferrer">
                  Open patient page ↗
                </a>
              )}
              {preview.paypalPayerUrl && (
                <a className="btn" href={preview.paypalPayerUrl} target="_blank" rel="noreferrer">
                  Open PayPal invoice ↗
                </a>
              )}
            </div>
          </>
        )}
        {error && <p className="email-page-status is-failed">{error}</p>}
      </div>
      {srcDoc && (
        <iframe
          ref={frame}
          className="email-frame"
          title={`Email: ${preview!.subject}`}
          srcDoc={srcDoc}
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          style={{ height }}
          onLoad={() => {
            const doc = frame.current?.contentDocument;
            if (doc) setHeight(doc.documentElement.scrollHeight + 4);
          }}
        />
      )}
    </div>
  );
}
