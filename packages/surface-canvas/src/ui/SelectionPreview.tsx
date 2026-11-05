/**
 * A screenshot of the frame being checked.
 *
 * The image is drawn at the panel's width and as tall as the selection is, inside
 * a box with a maximum height, so a single card shows whole and a full page
 * scrolls.
 */
import type { JSX } from "react";
import { useEffect, useState } from "react";
import type { SelectionPreview as Preview } from "../protocol.js";

export function SelectionPreview({ preview }: { preview: Preview | null }): JSX.Element | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!preview) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(new Blob([preview.png as BlobPart], { type: "image/png" }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [preview]);

  if (!preview || !url) return null;

  return (
    <section className="fs-card fs-preview" aria-label="Selection preview">
      <div className="fs-preview-head">
        <strong className="truncate">{preview.name}</strong>
        <span>
          {preview.width} × {preview.height}
        </span>
      </div>
      <div className="fs-preview-scroll">
        <img src={url} alt={`Screenshot of ${preview.name}`} />
      </div>
    </section>
  );
}
