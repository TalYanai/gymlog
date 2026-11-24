// Step 2d.1 — file input and output for the browser UI. No storage access here.
import { h } from './dom.js';

/**
 * Opens the file picker. Resolves { name, size, bytes: Uint8Array, text } or null when cancelled.
 * The bytes are read once; the facade copies them again at the call.
 */
export function pickFile({ accept = 'application/json,.json' } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, hidden: true }); // no inline style (CSP, 2e)
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(v);
    };
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      if (!f) return done(null);
      const bytes = new Uint8Array(await f.arrayBuffer());
      done({ name: f.name, size: f.size, bytes, text: new TextDecoder('utf-8').decode(bytes) });
    });
    input.addEventListener('cancel', () => done(null));
    document.body.append(input);
    input.click();
  });
}

/**
 * Hands a text file to the user: share sheet, then download, then clipboard (2a R5).
 * @returns {Promise<'shared'|'downloaded'|'copied'|'failed'|'cancelled'>}
 */
export async function deliverFile(fileName, text) {
  const file = new File([text], fileName, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] });
      return 'shared';
    }
  } catch (err) {
    if (err?.name === 'AbortError') return 'cancelled';
    // share failed → download
  }
  try {
    const url = URL.createObjectURL(file);
    const a = h('a', { href: url, download: fileName });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return 'downloaded';
  } catch {
    try {
      await navigator.clipboard.writeText(text);
      return 'copied';
    } catch {
      return 'failed';
    }
  }
}

/** A Hebrew message box (modal dialog). Resolves when closed. */
export function messageBox(text, { title = null } = {}) {
  return new Promise((resolve) => {
    const d = h('dialog', { class: 'sheet' }, title ? h('h2', {}, title) : null, h('pre', {}, text), h('button', { type: 'button', class: 'pri', onclick: () => d.close() }, 'סגור'));
    document.body.append(d);
    d.addEventListener('close', () => { d.remove(); resolve(); });
    d.showModal();
  });
}

/** A confirmation dialog. Resolves true only for the confirm button. */
export function confirmBox(text, { confirmLabel = 'אישור', cancelLabel = 'ביטול', danger = false } = {}) {
  return new Promise((resolve) => {
    let answer = false;
    const d = h('dialog', { class: 'sheet' },
      h('pre', {}, text),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: danger ? 'danger' : 'pri', onclick: () => { answer = true; d.close(); } }, confirmLabel),
        h('button', { type: 'button', onclick: () => d.close() }, cancelLabel)));
    document.body.append(d);
    d.addEventListener('close', () => { d.remove(); resolve(answer); });
    d.showModal();
  });
}

/** A three-way dialog. Resolves the id of the chosen option, or 'stay' when dismissed. */
export function choiceBox(text, options) {
  return new Promise((resolve) => {
    let answer = 'stay';
    const d = h('dialog', { class: 'sheet', 'data-dialog': 'choice' },
      h('pre', {}, text),
      h('div', { class: 'col' }, ...options.map((o) => h('button', { type: 'button', class: o.class ?? '', 'data-choice': o.id, onclick: () => { answer = o.id; d.close(); } }, o.label))));
    document.body.append(d);
    d.addEventListener('close', () => { d.remove(); resolve(answer); });
    d.showModal();
  });
}

/** The environment inputs of detectEnvironment, read from the browser. */
export function readEnvironmentInputs(win = window) {
  const nav = win.navigator;
  return {
    hostname: win.location.hostname,
    userAgent: nav.userAgent ?? '',
    platform: nav.platform ?? '',
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    standalone: nav.standalone === true || !!win.matchMedia?.('(display-mode: standalone)').matches,
  };
}

/** A one-field text dialog (2d.7). Resolves the trimmed text, or null when cancelled. */
export function promptBox(label, value = '', { confirmLabel = 'שמור' } = {}) {
  return new Promise((resolve) => {
    let answer = null;
    const input = h('input', { type: 'text', class: 'in', value, dir: 'auto', 'aria-label': label });
    const d = h('dialog', { class: 'sheet' },
      h('label', {}, label, input),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'pri', onclick: () => { answer = input.value.trim(); d.close(); } }, confirmLabel),
        h('button', { type: 'button', onclick: () => d.close() }, 'ביטול')));
    document.body.append(d);
    d.addEventListener('close', () => { d.remove(); resolve(answer); });
    d.showModal();
    input.focus();
  });
}
