// Opaque-origin iframe: inline chart scripts work, network and parent access do not.
export const PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export function isolatedHtml(content: string): string {
  // Must precede every byte of untrusted markup; later policies cannot relax it.
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><meta name="referrer" content="no-referrer">${content}`;
}
