// Literal: a Markdown editor whose document IS the source text.
// Styling is applied to the text in place (headings, bold, bullets, ...), but every
// line in the file is a line on screen. Blank lines, whitespace-only lines and
// indentation are always visible, and saving writes the text back byte for byte.

import { EditorState, EditorSelection, Compartment } from '@codemirror/state';
import {
  EditorView, keymap, Decoration, ViewPlugin, WidgetType,
  drawSelection, dropCursor, highlightActiveLine, highlightTrailingWhitespace,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentMore, indentLess, undo, redo } from '@codemirror/commands';
import { searchKeymap, openSearchPanel } from '@codemirror/search';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree, indentUnit } from '@codemirror/language';

const api = window.literal;
const INDENT = '  ';
// Widths of the pieces that stand in front of a list item's text, in em of the line's font.
// Wrapped lines of the item are indented by their sum, so the text never sits left of its bullet.
const INDENT_EM = 1.6;   // one two-space indent level (also sets --indent in the stylesheet)
const BULLET_EM = 1.5;   // bullet plus the space after it
const CHECK_EM = 1.4;    // checkbox plus the space after it

// =====================================================================
// Rendered mode decorations
// =====================================================================
// The document is shown as the finished page: headings, bold, links, bullets,
// checkboxes and images are rendered and their markup is hidden. Inline markup
// (**, _, `, [..](..)) reappears only while the cursor is inside that span, so it
// can still be edited by hand. Line-level markup (#, >, fences, ---) stays hidden
// except on structural lines (fences, rules) when the cursor is on them.
class BulletWidget extends WidgetType {
  constructor(depth) { super(); this.depth = depth; }
  eq(o) { return o.depth === this.depth; }
  toDOM() {
    const s = document.createElement('span');
    s.className = `lm-bullet d${Math.min(this.depth, 4)}`;
    s.style.width = `${BULLET_EM}em`;
    s.textContent = ['•', '◦', '▪', '▫'][(this.depth - 1) % 4];
    return s;
  }
  ignoreEvent() { return false; }
}
// An ordered-list number, fixed-width so wrapped lines can line up under the text.
class NumberWidget extends WidgetType {
  constructor(text, em) { super(); this.text = text; this.em = em; }
  eq(o) { return o.text === this.text && o.em === this.em; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'lm-olmark';
    s.style.width = `${this.em}em`;
    s.textContent = this.text;
    return s;
  }
  ignoreEvent() { return false; }
}
const numberWidth = (text) => Math.max(BULLET_EM, 0.6 * text.length + 0.6);
class IndentWidget extends WidgetType {
  constructor(cols) { super(); this.cols = cols; }
  eq(o) { return o.cols === this.cols; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'lm-indent';
    const full = Math.floor(this.cols / 2), half = this.cols % 2;
    for (let i = 0; i < full; i++) { const l = document.createElement('span'); l.className = 'lvl'; s.appendChild(l); }
    if (half) { const l = document.createElement('span'); l.className = 'lvl half'; s.appendChild(l); }
    return s;
  }
  ignoreEvent() { return false; }
}
class HrWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement('span'); s.className = 'lm-hr'; return s; }
  ignoreEvent() { return false; }
}
// A task checkbox. Clicking it rewrites the `[ ]` / `[x]` it stands for.
class TaskWidget extends WidgetType {
  constructor(checked) { super(); this.checked = checked; }
  eq(o) { return o.checked === this.checked; }
  toDOM(view) {
    const b = document.createElement('input');
    b.type = 'checkbox'; b.className = 'lm-check'; b.checked = this.checked; b.tabIndex = -1;
    b.style.marginRight = `${CHECK_EM - 1}em`;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(b);
      const cur = view.state.doc.sliceString(pos, pos + 3);
      if (!/^\[[ xX]\]$/.test(cur)) return;
      view.dispatch({ changes: { from: pos, to: pos + 3, insert: this.checked ? '[ ]' : '[x]' }, userEvent: 'input' });
    });
    return b;
  }
  ignoreEvent() { return true; }
}
// The language label that replaces an opening ``` line; the closing line becomes blank.
class FenceWidget extends WidgetType {
  constructor(info) { super(); this.info = info; }
  eq(o) { return o.info === this.info; }
  toDOM() { const s = document.createElement('span'); s.className = 'lm-fence-label'; s.textContent = this.info; return s; }
  ignoreEvent() { return false; }
}
class ImageWidget extends WidgetType {
  constructor(src, alt) { super(); this.src = src; this.alt = alt; }
  eq(o) { return o.src === this.src && o.alt === this.alt; }
  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'lm-image';
    const img = document.createElement('img');
    img.src = resolveImage(this.src); img.alt = this.alt; img.title = this.alt;
    img.addEventListener('error', () => { wrap.classList.add('broken'); wrap.textContent = `⚠ ${this.alt || 'image'} (${this.src})`; });
    wrap.appendChild(img);
    return wrap;
  }
  ignoreEvent() { return false; }
}

// Image paths are relative to the file (or the open folder for an unsaved file).
function resolveImage(src) {
  src = src.trim().replace(/^<|>$/g, '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return src;
  const base = current.file ? current.file.slice(0, current.file.lastIndexOf('/')) : current.folder;
  if (!base) return src;
  const path = src.startsWith('/') ? src : `${base}/${src.replace(/^\.\//, '')}`;
  return 'file://' + encodeURI(path);
}

const hide = Decoration.replace({});
const mark = (cls) => Decoration.mark({ class: cls });
const lineCls = (cls) => Decoration.line({ class: cls });

function buildDecorations(view) {
  const { state } = view;
  const doc = state.doc;
  const decos = [];   // all decorations
  const atomic = [];  // replaced ranges the cursor should skip over
  const sel = state.selection.ranges;
  // Strictly inside a span: a cursor right before or after it does not count.
  const inside = (from, to) => sel.some((r) => r.from < to && r.to > from);
  // On or next to a range, inclusive.
  const touches = (from, to) => sel.some((r) => r.from <= to && r.to >= from);
  const lineTouched = (pos) => { const l = doc.lineAt(pos); return touches(l.from, l.to); };
  const linesOf = (from, to, cls) => {
    for (let p = from; p <= to;) { const l = doc.lineAt(p); decos.push(lineCls(cls).range(l.from)); p = l.to + 1; }
  };
  const replace = (from, to, deco) => { if (to > from) { decos.push(deco.range(from, to)); atomic.push(deco.range(from, to)); } };
  const hideMark = (from, to, shown) => { if (shown) decos.push(mark('lm-mark').range(from, to)); else replace(from, to, hide); };
  const hideWithSpace = (from, to, shown) => {
    const end = doc.sliceString(to, to + 1) === ' ' ? to + 1 : to;
    hideMark(from, end, shown);
  };
  const restOfLine = (pos) => { const l = doc.lineAt(pos); return l.text.slice(pos - l.from); };

  const tree = syntaxTree(state);
  for (const { from, to } of view.visibleRanges) {
    // Indentation guides on every visible line that starts with whitespace but isn't blank.
    for (let p = from; p <= to;) {
      const l = doc.lineAt(p);
      const m = /^[ \t]+/.exec(l.text);
      if (m && m[0].length < l.text.length) {
        let cols = 0; for (const ch of m[0]) cols += ch === '\t' ? 2 : 1;
        replace(l.from, l.from + m[0].length, Decoration.replace({ widget: new IndentWidget(cols) }));
      }
      p = l.to + 1;
    }

    tree.iterate({
      from, to,
      enter(node) {
        const n = node.name;
        if (/^ATXHeading[1-6]$/.test(n)) {
          const level = +n.slice(-1);
          linesOf(node.from, node.to, `lm-h${level}`);
          // A heading with no text yet keeps its # visible, so an empty line can't be a secret heading.
          const empty = /^#+[ \t]*(#+[ \t]*)?$/.test(doc.sliceString(node.from, node.to));
          for (let c = node.node.firstChild; c; c = c.nextSibling) {
            if (c.name === 'HeaderMark') c.from === node.from ? hideWithSpace(c.from, c.to, empty) : hideMark(c.from, c.to, empty);
          }
        } else if (/^SetextHeading[12]$/.test(n)) {
          const level = +n.slice(-1);
          const first = doc.lineAt(node.from);
          decos.push(lineCls(`lm-h${level}`).range(first.from));
          for (let c = node.node.firstChild; c; c = c.nextSibling) if (c.name === 'HeaderMark') decos.push(mark('lm-mark').range(c.from, c.to));
        } else if (n === 'StrongEmphasis' || n === 'Emphasis' || n === 'Strikethrough' || n === 'InlineCode') {
          const cls = { StrongEmphasis: 'lm-strong', Emphasis: 'lm-em', Strikethrough: 'lm-strike', InlineCode: 'lm-code' }[n];
          const shown = inside(node.from, node.to);
          const ranges = [];
          for (let c = node.node.firstChild; c; c = c.nextSibling) {
            if (c.name === 'EmphasisMark' || c.name === 'StrikethroughMark' || c.name === 'CodeMark') ranges.push([c.from, c.to]);
          }
          // style the content between the marks
          if (ranges.length >= 2) decos.push(mark(cls).range(ranges[0][1], ranges[ranges.length - 1][0]));
          else decos.push(mark(cls).range(node.from, node.to));
          for (const [a, b] of ranges) hideMark(a, b, shown);
        } else if (n === 'Link' || n === 'Image') {
          const marks = [];
          for (let c = node.node.firstChild; c; c = c.nextSibling) {
            if (c.name === 'LinkMark' || c.name === 'URL' || c.name === 'LinkTitle' || c.name === 'LinkLabel') marks.push([c.from, c.to, c.name]);
          }
          let textFrom = node.from, textTo = node.to;
          if (marks.length >= 2) { textFrom = marks[0][1]; textTo = marks[1][0]; }
          if (n === 'Image') {
            // The whole image is one atomic widget, so it is revealed when the cursor is next to it.
            if (!touches(node.from, node.to)) {
              const url = node.node.getChild('URL');
              const src = url ? doc.sliceString(url.from, url.to) : '';
              replace(node.from, node.to, Decoration.replace({ widget: new ImageWidget(src, doc.sliceString(textFrom, textTo)) }));
              return false;
            }
            decos.push(mark('lm-em').range(textFrom, textTo));
            for (const [a, b, name] of marks) decos.push(mark(name === 'URL' ? 'lm-url' : 'lm-mark').range(a, b));
            return false;
          }
          const shown = inside(node.from, node.to);
          decos.push(mark('lm-link').range(textFrom, textTo));
          for (const [a, b, name] of marks) {
            if (shown) decos.push(mark(name === 'URL' ? 'lm-url' : 'lm-mark').range(a, b));
            else replace(a, b, hide);
          }
          return false;
        } else if (n === 'Autolink' || n === 'URL') {
          decos.push(mark('lm-link').range(node.from, node.to));
        } else if (n === 'Escape') {
          hideMark(node.from, node.from + 1, inside(node.from, node.to));
        } else if (n === 'ListMark') {
          const item = node.node.parent;                 // ListItem
          const list = item && item.parent;              // BulletList / OrderedList
          const line = doc.lineAt(node.from);
          const spaceAfter = (to) => (doc.sliceString(to, to + 1) === ' ' ? to + 1 : to);
          // Width of everything in front of the text: indent guides, marker, checkbox.
          let cols = 0;
          for (const ch of /^[ \t]*/.exec(line.text)[0]) cols += ch === '\t' ? 2 : 1;
          let prefix = Math.floor(cols / 2) * INDENT_EM + (cols % 2) * (INDENT_EM / 2);
          if (list && list.name === 'BulletList') {
            let depth = 0;
            for (let a = item; a; a = a.parent) if (a.name === 'ListItem') depth++;
            replace(node.from, spaceAfter(node.to), Decoration.replace({ widget: new BulletWidget(depth) }));
            prefix += BULLET_EM;
          } else {
            const text = doc.sliceString(node.from, node.to);
            const em = numberWidth(text);
            replace(node.from, spaceAfter(node.to), Decoration.replace({ widget: new NumberWidget(text, em) }));
            prefix += em;
          }
          const task = item && item.getChild('Task');
          const marker = task && task.getChild('TaskMarker');
          if (marker) {
            const checked = /x/i.test(doc.sliceString(marker.from, marker.to));
            replace(marker.from, spaceAfter(marker.to), Decoration.replace({ widget: new TaskWidget(checked) }));
            prefix += CHECK_EM;
          }
          let quoted = false;
          for (let a = item; a; a = a.parent) if (a.name === 'Blockquote') quoted = true;
          const base = quoted ? 0.8 : 0;   // matches .lm-quote padding-left
          decos.push(Decoration.line({ attributes: { style: `padding-left:${(base + prefix).toFixed(2)}em;text-indent:-${prefix.toFixed(2)}em` } }).range(line.from));
        } else if (n === 'Blockquote') {
          linesOf(node.from, node.to, 'lm-quote');
        } else if (n === 'QuoteMark') {
          // An empty quote line keeps its > visible, for the same reason as an empty heading.
          hideWithSpace(node.from, node.to, restOfLine(node.to).trim() === '');
        } else if (n === 'FencedCode' || n === 'CodeBlock') {
          linesOf(node.from, node.to, 'lm-codeblock');
          if (n === 'FencedCode') {
            const info = node.node.getChild('CodeInfo');
            let i = 0;
            for (let c = node.node.firstChild; c; c = c.nextSibling) {
              if (c.name !== 'CodeMark') continue;
              const l = doc.lineAt(c.from);
              decos.push(lineCls(i === 0 ? 'lm-fence-open' : 'lm-fence-close').range(l.from));
              if (lineTouched(c.from)) {
                decos.push(mark('lm-fence').range(c.from, c.to));
                if (i === 0 && info) decos.push(mark('lm-fence').range(info.from, info.to));
              } else if (i === 0) {
                replace(c.from, l.to, Decoration.replace({ widget: new FenceWidget(info ? doc.sliceString(info.from, info.to) : '') }));
              } else {
                replace(c.from, c.to, hide);
              }
              i++;
            }
          }
          return false;
        } else if (n === 'Table') {
          linesOf(node.from, node.to, 'lm-table');
        } else if (n === 'HorizontalRule') {
          const l = doc.lineAt(node.from);
          if (touches(l.from, l.to)) decos.push(mark('lm-hr-line').range(node.from, node.to));
          else replace(node.from, node.to, Decoration.replace({ widget: new HrWidget() }));
        } else if (n === 'HTMLTag' || n === 'HTMLBlock' || n === 'Comment' || n === 'CommentBlock') {
          decos.push(mark('lm-mark').range(node.from, node.to));
        }
      },
    });
  }
  return { decorations: Decoration.set(decos, true), atomic: Decoration.set(atomic, true) };
}

const rendered = ViewPlugin.fromClass(class {
  constructor(view) { Object.assign(this, buildDecorations(view)); }
  update(u) { if (u.docChanged || u.viewportChanged || u.selectionSet) Object.assign(this, buildDecorations(u.view)); }
}, {
  decorations: (v) => v.decorations,
  provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic || Decoration.none),
});

// =====================================================================
// Editing commands
// =====================================================================
const LIST_RE = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/;

// Enter: continue a list item, exit an empty one, otherwise a bare newline.
// Never auto-indents, so the editor never creates whitespace-only lines.
function insertNewline(view) {
  const { state } = view;
  const tr = state.changeByRange((range) => {
    const line = state.doc.lineAt(range.head);
    const m = LIST_RE.exec(line.text);
    if (m && range.empty) {
      const [, indent, marker, space, task, rest] = m;
      const contentStart = line.from + indent.length + marker.length + space.length + (task || '').length;
      if (range.head >= contentStart) {
        if (rest.trim() === '' && range.head === line.to) {
          // empty item: remove the marker and leave the list
          return { changes: { from: line.from, to: line.to, insert: '' }, range: EditorSelection.cursor(line.from) };
        }
        const num = /^(\d+)([.)])$/.exec(marker);
        const next = num ? `${+num[1] + 1}${num[2]}` : marker;
        const insert = `\n${indent}${next}${space}${task ? '[ ] ' : ''}`;
        return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + insert.length) };
      }
    }
    return { changes: { from: range.from, to: range.to, insert: '\n' }, range: EditorSelection.cursor(range.from + 1) };
  });
  view.dispatch(tr, { scrollIntoView: true, userEvent: 'input' });
  return true;
}

function toggleWrap(view, wrap) {
  const { state } = view;
  const n = wrap.length;
  const tr = state.changeByRange((range) => {
    let { from, to } = range;
    if (range.empty) {
      // select the word under the cursor
      const line = state.doc.lineAt(from);
      let a = from, b = from;
      while (a > line.from && /\S/.test(line.text[a - line.from - 1])) a--;
      while (b < line.to && /\S/.test(line.text[b - line.from])) b++;
      from = a; to = b;
    }
    const before = state.doc.sliceString(Math.max(0, from - n), from);
    const after = state.doc.sliceString(to, to + n);
    const text = state.doc.sliceString(from, to);
    if (before === wrap && after === wrap) {
      return { changes: [{ from: from - n, to: from }, { from: to, to: to + n }], range: EditorSelection.range(from - n, to - n) };
    }
    if (text.startsWith(wrap) && text.endsWith(wrap) && text.length >= 2 * n) {
      return { changes: { from, to, insert: text.slice(n, -n) }, range: EditorSelection.range(from, to - 2 * n) };
    }
    return { changes: [{ from, insert: wrap }, { from: to, insert: wrap }], range: EditorSelection.range(from + n, to + n) };
  });
  view.dispatch(tr, { userEvent: 'input' });
  return true;
}

function toggleBullet(view) {
  const { state } = view;
  const lines = new Map();
  for (const r of state.selection.ranges) {
    for (let p = r.from; p <= r.to;) { const l = state.doc.lineAt(p); lines.set(l.from, l); p = l.to + 1; }
  }
  const changes = [];
  for (const l of lines.values()) {
    const m = /^([ \t]*)([-*+][ \t]+)/.exec(l.text);
    if (m) changes.push({ from: l.from + m[1].length, to: l.from + m[0].length, insert: '' });
    else { const ws = /^[ \t]*/.exec(l.text)[0]; changes.push({ from: l.from + ws.length, insert: '- ' }); }
  }
  view.dispatch({ changes, userEvent: 'input' });
  return true;
}

// =====================================================================
// Editor setup
// =====================================================================
const viewMode = new Compartment();
let view;

// Fonts and the active line are set here rather than in styles.css because
// CodeMirror's base theme would otherwise win on specificity.
const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '17px', backgroundColor: 'transparent' },
  '.cm-scroller': { fontFamily: 'var(--prose-font)', lineHeight: '1.6', padding: '20px 0 40vh' },
  '.cm-content': { maxWidth: '720px', margin: '0 auto', padding: '0 48px', caretColor: 'var(--fg)' },
  '.cm-line': { padding: '0' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--selection)' },
  '.cm-panels': { backgroundColor: 'var(--sidebar-bg)', color: 'var(--fg)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 25%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--accent) 50%, transparent)' },
  '&.raw-mode .cm-scroller': { fontFamily: 'var(--mono-font)', fontSize: '0.9em' },
});
let current = { file: null, folder: null, savedText: '' };
let preferRaw = false;   // the last Rendered / Raw choice made on a Markdown file
let dirty = false;

function makeState(text) {
  return EditorState.create({
    doc: text,
    extensions: [
      theme,
      history(),
      drawSelection(),
      dropCursor(),
      highlightActiveLine(),
      highlightTrailingWhitespace(),
      EditorView.lineWrapping,
      indentUnit.of(INDENT),
      EditorState.tabSize.of(2),
      markdown({ base: markdownLanguage, addKeymap: false }),
      viewMode.of(rendered),
      keymap.of([
        { key: 'Enter', run: insertNewline },
        { key: 'Tab', run: indentMore },
        { key: 'Shift-Tab', run: indentLess },
        ...searchKeymap,
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) setDirty(u.state.doc.toString() !== current.savedText);
        if (u.docChanged || u.selectionSet) updateStatus();
      }),
      EditorView.domEventHandlers({
        click(e) {
          const a = e.target.closest && e.target.closest('.lm-link');
          if (a && (e.metaKey || e.ctrlKey)) {
            const url = linkUrlAt(view.posAtDOM(a));
            if (url) { api.openExternal(url); return true; }
          }
          return false;
        },
      }),
    ],
  });
}

function linkUrlAt(pos) {
  const tree = syntaxTree(view.state);
  let node = tree.resolveInner(pos, 1);
  for (let n = node; n; n = n.parent) {
    if (n.name === 'Link') {
      const url = n.getChild('URL');
      return url ? view.state.doc.sliceString(url.from, url.to) : null;
    }
    if (n.name === 'Autolink' || n.name === 'URL') return view.state.doc.sliceString(n.from, n.to).replace(/^<|>$/g, '');
  }
  return null;
}

// =====================================================================
// Files, sidebar, status
// =====================================================================
const $ = (id) => document.getElementById(id);

function setDirty(d) {
  if (d === dirty) return;
  dirty = d;
  api.setDirty(dirty, current.file);
  updateTitle();
}
function updateTitle() {
  const name = current.file ? current.file.split('/').pop() : 'Untitled';
  document.title = `${name}${dirty ? ' — Edited' : ''}`;
  $('status-file').textContent = current.file || 'Untitled';
  const d = $('status-dirty');
  d.textContent = dirty ? 'Unsaved changes' : 'Saved';
  d.className = dirty ? 'dirty' : 'clean';
}
function updateStatus() {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  $('status-pos').textContent = `Ln ${line.number}, Col ${head - line.from + 1}`;
}

async function loadFile(file) {
  const text = await api.readFile(file);
  current.file = file;
  current.savedText = text;
  view.setState(makeState(text));
  dirty = false;
  api.setDirty(false, file);
  api.watchFile(file);
  applyRaw(isMarkdown(file) ? preferRaw : true);
  updateTitle(); updateStatus(); markActive();
  api.setState({ file });
  // The sidebar always shows the folder the open file is in.
  const folder = file.slice(0, file.lastIndexOf('/'));
  if (!current.folder || !file.startsWith(current.folder + '/')) await loadFolder(folder);
  await revealInTree(file);
}

// `newWindow` opens the file in a window of its own instead of replacing this one.
async function openFile(file, newWindow = false) {
  if (file === current.file && !newWindow) return;
  const kind = await api.probeFile(file);
  if (kind === 'missing') { await refreshFolder(); return; }
  if (kind !== 'text') { api.openPath(file); return; }   // binary or huge: hand it to the OS
  if (newWindow) { api.openInNewWindow(file); return; }
  if (dirty && !(await api.confirmDiscard())) return;
  await loadFile(file);
}

async function save() {
  if (!current.file) return saveAs();
  const text = view.state.doc.toString();
  await api.writeFile(current.file, text);
  current.savedText = text;
  setDirty(false);
  api.notifySaved();
  return true;
}
async function saveAs() {
  const def = current.file || (current.folder ? `${current.folder}/Untitled.md` : 'Untitled.md');
  const file = await api.saveAsDialog(def);
  if (!file) return false;
  current.file = file;
  const text = view.state.doc.toString();
  await api.writeFile(file, text);
  current.savedText = text;
  dirty = true; setDirty(false);
  api.watchFile(file); api.notifySaved();
  updateTitle();
  if (!current.folder || !file.startsWith(current.folder)) await loadFolder(file.slice(0, file.lastIndexOf('/'))); else await refreshFolder();
  markActive();
  return true;
}

// ---------- folder tree ----------
// The sidebar shows every file under the open folder as a tree. Each folder's contents
// are fetched when it is first expanded and cached until the next refresh.
const tree = { cache: new Map(), expanded: new Set() };
const isMarkdown = (f) => /\.(md|markdown)$/i.test(f);

async function loadDir(dir) {
  const r = await api.listFolder(dir);
  tree.cache.set(dir, r);
  return r;
}
async function toggleDir(dir) {
  if (tree.expanded.has(dir)) tree.expanded.delete(dir);
  else { tree.expanded.add(dir); if (!tree.cache.has(dir)) await loadDir(dir); }
  renderTree();
  api.setState({ expanded: [...tree.expanded] });
}
function renderTree() {
  const ul = $('file-list');
  ul.innerHTML = '';
  if (current.folder) renderDir(current.folder, ul, 0);
  markActive();
}
function row(li, depth, onClick) {
  li.style.setProperty('--depth', depth);
  const r = document.createElement('div');
  r.className = 'row';
  r.addEventListener('click', onClick);
  li.appendChild(r);
  return r;
}
function renderDir(dir, ul, depth) {
  const r = tree.cache.get(dir);
  if (!r) return;
  for (const d of r.dirs) {
    const li = document.createElement('li');
    const open = tree.expanded.has(d.path);
    li.className = 'dir' + (open ? ' open' : '');
    li.title = d.path;
    const rw = row(li, depth, () => toggleDir(d.path));
    const chev = document.createElement('span'); chev.className = 'chev'; rw.appendChild(chev);
    const name = document.createElement('span'); name.className = 'name'; name.textContent = d.name; rw.appendChild(name);
    if (open) { const sub = document.createElement('ul'); renderDir(d.path, sub, depth + 1); li.appendChild(sub); }
    ul.appendChild(li);
  }
  for (const f of r.files) {
    const li = document.createElement('li');
    li.className = 'file' + (isMarkdown(f.name) ? ' md' : '');
    li.dataset.path = f.path;
    li.title = f.path;
    const rw = row(li, depth, (e) => openFile(f.path, e.metaKey || e.ctrlKey));
    const name = document.createElement('span'); name.className = 'name'; name.textContent = f.name; rw.appendChild(name);
    ul.appendChild(li);
  }
}
// Expand every folder between the open folder and `file`, so the active file is visible.
async function revealInTree(file) {
  if (!current.folder || !file.startsWith(current.folder + '/')) return;
  const parts = file.slice(current.folder.length + 1).split('/');
  parts.pop();
  let dir = current.folder, changed = false;
  for (const p of parts) {
    dir = `${dir}/${p}`;
    if (!tree.expanded.has(dir)) { tree.expanded.add(dir); changed = true; }
    if (!tree.cache.has(dir)) await loadDir(dir);
  }
  if (changed) api.setState({ expanded: [...tree.expanded] });
  renderTree();
  const li = $('file-list').querySelector('li.active');
  if (li) li.scrollIntoView({ block: 'nearest' });
}

async function loadFolder(folder, expanded = []) {
  current.folder = folder;
  tree.expanded = new Set(expanded.filter((d) => d.startsWith(folder + '/')));
  $('folder-name').textContent = folder.split('/').pop();
  $('folder-name').title = folder;
  await refreshFolder();
  api.setState({ folder, expanded: [...tree.expanded] });
}
async function refreshFolder() {
  if (!current.folder) return;
  tree.cache.clear();
  await loadDir(current.folder);
  for (const d of tree.expanded) await loadDir(d);
  renderTree();
}
function markActive() {
  for (const li of $('file-list').querySelectorAll('li.file')) li.classList.toggle('active', li.dataset.path === current.file);
}

function setSidebar(visible) {
  $('sidebar').classList.toggle('hidden', !visible);
  $('sidebar-handle').classList.toggle('hidden', visible);
  api.setState({ sidebarHidden: !visible });
}

// ---------- Rendered / Raw ----------
// Rendered shows the document as a page; Raw shows the exact source text in monospace.
// Both edit the same text, so switching never changes the file.
let rawOn = false;
function applyRaw(on) {
  rawOn = on;
  view.dispatch({ effects: viewMode.reconfigure(on ? [] : rendered) });
  view.dom.classList.toggle('raw-mode', on);
  $('mode-rendered').classList.toggle('active', !on);
  $('mode-raw').classList.toggle('active', on);
  $('mode-rendered').setAttribute('aria-checked', String(!on));
  $('mode-raw').setAttribute('aria-checked', String(on));
}
// Choosing a mode by hand is remembered for the next Markdown file; other files always open Raw.
function chooseMode(raw) {
  applyRaw(raw);
  if (!current.file || isMarkdown(current.file)) { preferRaw = raw; api.setState({ raw }); }
  view.focus();
}
function toggleRaw() { chooseMode(!rawOn); }

// =====================================================================
// Boot
// =====================================================================
async function boot() {
  document.documentElement.style.setProperty('--indent', `${INDENT_EM}em`);
  view = new EditorView({ state: makeState(''), parent: $('editor') });
  updateTitle(); updateStatus();

  $('choose-folder').addEventListener('click', async () => { const f = await api.openFolderDialog(); if (f) loadFolder(f); });
  $('sidebar-collapse').addEventListener('click', () => setSidebar(false));
  $('sidebar-handle').addEventListener('click', () => setSidebar(true));
  $('mode-rendered').addEventListener('click', () => chooseMode(false));
  $('mode-raw').addEventListener('click', () => chooseMode(true));

  api.onMenu(async (cmd) => {
    switch (cmd) {
      case 'open': { const f = await api.openFileDialog(); if (f) openFile(f); return; }
      case 'open-folder': { const f = await api.openFolderDialog(); if (f) loadFolder(f); return; }
      case 'save': { if (!(await save())) api.notifySaveCancelled(); return; }
      case 'save-as': return saveAs();
      case 'reveal': return api.reveal(current.file);
      case 'undo': undo(view); return;
      case 'redo': redo(view); return;
      case 'find': openSearchPanel(view); return;
      case 'bold': toggleWrap(view, '**'); return;
      case 'italic': toggleWrap(view, '_'); return;
      case 'bullet': toggleBullet(view); return;
      case 'toggle-sidebar': setSidebar($('sidebar').classList.contains('hidden')); return;
      case 'toggle-raw': return toggleRaw();
    }
  });
  let openedFromOS = false;
  api.onOpenPath((file) => { openedFromOS = true; openFile(file); });   // routed here by the main process
  api.onFileChanged(async (file) => {
    if (file !== current.file || dirty) return;
    const text = await api.readFile(file);
    if (text === current.savedText) return;
    const head = Math.min(view.state.selection.main.head, text.length);
    current.savedText = text;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: head } });
    setDirty(false);
  });

  // drag & drop a file onto the window
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f && f.path) openFile(f.path);
  });

  const st = await api.getState();
  preferRaw = !!st.raw;
  applyRaw(preferRaw);
  if (st.sidebarHidden) setSidebar(false);
  if (st.folder) await loadFolder(st.folder, st.expanded || []);
  if (st.file && !openedFromOS) { try { await loadFile(st.file); } catch {} }
  view.focus();
}
boot();
