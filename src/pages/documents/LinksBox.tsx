import { useState } from "react";
import type { ProjectDocument } from "../../types";
import { asWebUrl } from "../../services/urls";
import { addDocumentLink, linksOf, removeDocumentLink } from "../../services/wrapped/documents";
import { nameOf } from "../../services/wrapped/people";
import { fmtDate } from "../../services/utils";
import { useApp } from "../../ui/AppContext";
import { OpenLinkButton } from "../../ui/workflow/shared";

// A document's links: files that stay where they are (Google Docs, Drive, WhatsApp and the like). They open in the
// person's own browser, never inside the app, with the same check every link in the app gets (src/services/urls.ts).

/** What a link points at, worked out from its address. */
export function linkKind(url: string): string {
  const safe = asWebUrl(url);
  if (!safe) return "Link";
  const { hostname, pathname } = new URL(safe);
  if (hostname === "docs.google.com") {
    if (pathname.startsWith("/document")) return "Google Doc";
    if (pathname.startsWith("/spreadsheets")) return "Google Sheet";
    if (pathname.startsWith("/presentation")) return "Google Slides";
    return "Google Docs";
  }
  if (hostname === "drive.google.com") return "Google Drive";
  if (hostname === "wa.me" || hostname.endsWith("whatsapp.com")) return "WhatsApp";
  if (hostname.endsWith("youtube.com") || hostname === "youtu.be") return "YouTube";
  if (hostname.endsWith("dropbox.com")) return "Dropbox";
  return "Link";
}

export function LinksBox({ doc, write }: { doc: ProjectDocument; write: boolean }) {
  const { actor, attempt, confirm } = useApp();
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const links = linksOf(doc.id);
  const add = () => {
    if (attempt(() => addDocumentLink(actor, doc.id, url, label), "Link added")) {
      setUrl("");
      setLabel("");
    }
  };
  return (
    <section className="pd-links" aria-label="Links">
      <h3>Links</h3>
      {links.length === 0 ? (
        <p className="muted">No links yet. Files that live in Google Docs, Drive or WhatsApp can be linked here.</p>
      ) : (
        <ul>
          {links.map((l) => (
            <li key={l.id}>
              <span className="badge">{linkKind(l.url)}</span>
              <span className="grow pd-link-text" title={l.url}>
                {l.label || l.url}
              </span>
              <span className="muted pd-link-by">
                {nameOf(l.addedBy)}, {fmtDate(l.addedAt.slice(0, 10))}
              </span>
              <OpenLinkButton url={l.url}>Open</OpenLinkButton>
              {write && (
                <button
                  className="btn small ghost"
                  aria-label={`Remove the link ${l.label || l.url}`}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: "Remove this link?",
                        body: `${l.label || l.url}. The file itself is not touched.`,
                        confirmLabel: "Remove",
                        danger: true,
                      })
                    )
                      attempt(() => removeDocumentLink(actor, l.id), "Link removed");
                  }}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {write && (
        <form
          className="pd-link-add"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input
            type="url"
            aria-label="Link address"
            placeholder="https://docs.google.com/…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <input
            type="text"
            aria-label="What it is"
            placeholder="What it is (optional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <button className="btn small" type="submit" disabled={!url.trim()}>
            Add link
          </button>
        </form>
      )}
    </section>
  );
}
