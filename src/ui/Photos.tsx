import { useRef, useState } from "react";
import type { Attachment } from "../types";
import { useApp } from "./AppContext";
import { Modal } from "./Modal";
import type { PhotoInput } from "../services/wrapped/equipment";
import { fmtDateTime } from "../services/utils";

/** Shrinks a photo to a small JPEG so it fits comfortably in local storage. */
export function fileToDataUrl(file: File, maxSide = 640, quality = 0.6): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That file is not an image."));
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", quality));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/** Take or choose a photo, or paste a link. Calls onAdd with the result. */
export function PhotoAdd({ onAdd, label = "Add photo", allowLink = true }: { onAdd: (p: PhotoInput) => void; label?: string; allowLink?: boolean }) {
  const { toast } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const [link, setLink] = useState("");
  const [showLink, setShowLink] = useState(false);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try {
      onAdd({ url: await fileToDataUrl(f), caption: "" });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not add that photo.", "error");
    }
  };

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={onFile} style={{ display: "none" }} />
      <button type="button" className="btn small" onClick={() => fileRef.current?.click()}>{label}</button>
      {allowLink && !showLink && <button type="button" className="btn small ghost" onClick={() => setShowLink(true)}>Paste a link</button>}
      {showLink && (
        <>
          <input type="text" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://drive.google.com/…" style={{ width: 240 }} aria-label="Photo link" />
          <button type="button" className="btn small" onClick={() => { if (link.trim()) { onAdd({ url: link.trim(), caption: "" }); setLink(""); setShowLink(false); } }}>Add link</button>
        </>
      )}
    </div>
  );
}

/** A pending list of photos held in a form until it is saved. */
export function PhotoList({ value, onChange, label }: { value: PhotoInput[]; onChange: (v: PhotoInput[]) => void; label?: string }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      {value.length > 0 && (
        <div className="thumbs">
          {value.map((p, i) => (
            <div key={i} className="thumb-wrap">
              <Thumb url={p.url} />
              <button type="button" className="thumb-x" aria-label="Remove photo" onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
        </div>
      )}
      <PhotoAdd label={label} onAdd={(p) => onChange([...value, p])} />
    </div>
  );
}

function Thumb({ url, onClick }: { url: string; onClick?: () => void }) {
  const [broken, setBroken] = useState(false);
  if (broken || !url.startsWith("data:")) {
    return <a className="thumb link" href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Open link</a>;
  }
  return <img className="thumb" src={url} alt="" onError={() => setBroken(true)} onClick={onClick} />;
}

/** Saved attachments, each with its timestamp. Click an image to enlarge. */
export function Attachments({ items, empty = "None yet.", onRemove }: { items: Attachment[]; empty?: string; onRemove?: (id: string) => void }) {
  const [open, setOpen] = useState<Attachment | null>(null);
  if (!items.length) return <p className="muted">{empty}</p>;
  return (
    <>
      <div className="thumbs">
        {items.map((a) => (
          <figure key={a.id} className="thumb-fig">
            <div className="thumb-wrap">
              <Thumb url={a.url} onClick={() => setOpen(a)} />
              {onRemove && <button type="button" className="thumb-x" aria-label="Remove" onClick={() => onRemove(a.id)}>×</button>}
            </div>
            <figcaption>{new Date(a.at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</figcaption>
          </figure>
        ))}
      </div>
      {open && (
        <Modal title="Photo" onClose={() => setOpen(null)} actions={<button className="btn" onClick={() => setOpen(null)}>Close</button>}>
          <img src={open.url} alt="" style={{ width: "100%", borderRadius: 10 }} />
          <p className="muted" style={{ marginTop: 8 }}>Taken {fmtDateTime(open.at)}</p>
        </Modal>
      )}
    </>
  );
}
