import { useState, type ReactNode } from "react";
import { Modal } from "./Modal";
import { Field } from "./parts";

/** A small form asking for one line of text, and optionally one more choice. */
export function PromptModal({ title, label, confirmLabel, placeholder, extra, onSubmit, onClose, required = false }: {
  title: string;
  label: string;
  confirmLabel: string;
  placeholder?: string;
  extra?: ReactNode;
  required?: boolean;
  onSubmit: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  return (
    <Modal title={title} onClose={onClose} actions={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={required && !text.trim()} onClick={() => onSubmit(text)}>{confirmLabel}</button></>}>
      <div className="stack">
        {extra}
        <Field label={label}><textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} autoFocus /></Field>
      </div>
    </Modal>
  );
}
