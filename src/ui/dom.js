// Minimal DOM helpers (Step 2d.0). No innerHTML anywhere: text is always inserted as text nodes.

/** h('button', { class: 'pri', onclick }, 'text', childNode, …) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Isolates mixed-direction text (English exercise names, numbers with units) inside RTL Hebrew. */
export const bdi = (text) => h('bdi', {}, text);
