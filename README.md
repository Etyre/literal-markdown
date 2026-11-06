# Literal

A WYSIWYG Markdown editor that never hides or rewrites a line. The document on screen *is* the file:

- Every blank line in the file is a blank line on screen. Two blank lines look like two.
- Whitespace-only lines and trailing spaces are highlighted, so nothing invisible can sneak in.
- Indentation is drawn as fixed-width guides, so a nested bullet is unmistakably nested and a top-level one is unmistakably not. A list item that wraps keeps its continuation lines under its text, never left of the bullet.
- **Rendered** shows the page: headings, bold, links, bullets, checkboxes, images and code boxes, with the markup hidden. Inline markup (`**`, `_`, `` ` ``, `[]()`) reappears only while the cursor is inside that span, so it can still be edited by hand.
- **Raw** shows the exact source text in monospace. Switch between the two with the control in the top bar or ⌘/. Both edit the same text; switching never changes the file.
- Saving writes the editor text back byte for byte. The app never reformats, re-indents, or normalises blank lines.

Each window is one document with its own sidebar. Open as many as you like; every window, its file, folder, size and position come back on the next launch.

Built with Electron and CodeMirror 6. The renderer is `src/renderer.js`; the Electron main process is `main.js`.

## Run

```
npm install
npm start                       # build and launch
npm start -- path/to/file.md    # open a file on launch
```

## Install as an app

```
npm run install-app
```

Builds `dist/mac-arm64/Literal.app` and copies it to `/Applications`. Double-clicking a `.md` file in Finder and choosing Literal works once it is installed.

## Using it

| Action | Shortcut |
|---|---|
| New window | ⌘N |
| Open file / Open folder | ⌘O / ⇧⌘O |
| Open a sidebar file in a new window | ⌘-click it |
| Save / Save As | ⌘S / ⇧⌘S |
| Bold / Italic | ⌘B / ⌘I |
| Toggle bullet on the current line(s) | ⇧⌘8 |
| Indent / outdent line(s) | Tab / Shift-Tab |
| Find | ⌘F |
| Toggle sidebar | ⌘\ |
| Rendered / Raw | top bar, or ⌘/ |
| Open a link | ⌘-click |

Opening a folder shows every file in it as a tree in the sidebar; click a folder to expand or collapse it. Markdown files open in whichever of Rendered or Raw you chose last, other text files always open Raw, and binary files are handed to the app macOS would normally open them with. The sidebar always shows the folder of the open file. Opening a file from Finder focuses the window that already shows it, or opens a new window. The `«` button in the sidebar hides it and the `»` button at the top-left brings it back (or ⌘\). Every window's file, folder, expanded folders, sidebar state, size and position are reopened on launch.

In Rendered mode, clicking a checkbox toggles its `[ ]` / `[x]`, Backspace at the start of a heading or quote removes its hidden marker, and image paths are resolved relative to the file. An empty heading or quote line keeps its `#` or `>` visible so no line can be secretly structural.

Enter at the end of a bullet continues the list; Enter on an empty bullet ends it. Enter elsewhere inserts a plain newline with no automatic indentation, so the editor itself never creates whitespace-only lines.

If the open file changes on disk while you have no unsaved edits, it is reloaded automatically.
