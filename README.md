# Literal

A WYSIWYG Markdown editor for macOS that never hides or rewrites a line. It was built between 2026-10-30 and 2026-11-06 (first commit 2026-11-06) because every other Markdown editor either hides blank lines, collapses indentation, or quietly reformats the file on save, so what you see is not what is on disk. In Literal the document on screen *is* the file:

- Every blank line in the file is a blank line on screen. Two blank lines look like two.
- Whitespace-only lines and trailing spaces are highlighted, so nothing invisible can sneak in.
- Indentation is drawn as fixed-width guides, so a nested bullet is unmistakably nested and a top-level one is unmistakably not. A list item that wraps keeps its continuation lines under its text, never left of the bullet.
- **Rendered** shows the page: headings, bold, links, bullets, checkboxes, images and code boxes, with the markup hidden. Inline markup (`**`, `_`, `` ` ``, `[]()`) reappears only while the cursor is inside that span, so it can still be edited by hand.
- **Raw** shows the exact source text in monospace. Switch between the two with the control in the top bar or ⌘/. Both edit the same text; switching never changes the file.
- Saving writes the editor text back byte for byte. The app never reformats, re-indents, or normalises blank lines.

Each window is one document with its own sidebar. Open as many as you like; every window, its file, folder, size and position come back on the next launch.

Built with Electron and CodeMirror 6. Electron because the goal is a real Finder-openable macOS app with a native menu and file dialogs; CodeMirror 6 because its decoration system lets the markup be styled in place without ever replacing the text, which is the whole point.

## How it works

The Electron main process (`main.js`) owns windows, the menu, file dialogs, file I/O and file watching. Each `BrowserWindow` is an independent document with its own file, folder tree, dirty flag and `fs.watch` watcher; a `Map` from window to that record is the only app state. The renderer (`src/renderer.js`) is a CodeMirror 6 editor talking to the main process through the small API that `preload.js` exposes on `window.literal` (context isolation and sandbox are on; the renderer never touches Node).

Rendered mode is a set of CodeMirror decorations computed from the Markdown syntax tree: line-level markup (`#`, `>`, fences, rules) is hidden except on structural lines when the cursor is on them, inline markup is hidden unless the cursor is inside the span, bullets and checkboxes are replaced by widgets, and each list item's wrapped lines are indented by the width of what stands before its text. Raw mode is the same editor with those decorations switched off through a `Compartment`, and a monospace font. Nothing in either mode changes the document text; only typing and the explicit commands (bold, italic, bullet, indent, checkbox click) do.

Persistence: the main process writes `state.json` (every window's file, folder, expanded folders, sidebar state, bounds, and the shared Rendered/Raw preference) 200 ms after any change and again on quit. On launch every window from last time is recreated; files macOS asks to open (`open-file` event or a command-line argument) focus the window that already shows them or open a new one. If the open file changes on disk while the window has no unsaved edits, it is reloaded in place.

The Find panel (⌘F) is the only text input besides the document itself. Its search and replace text and its options are saved to `localStorage` on every change and restored into the editor state before the panel is shown, so a half-typed search survives switching files, closing the panel and relaunching. The document itself is the file, so it is deliberately not treated as a draft: closing a window with unsaved edits asks Save / Don't Save / Cancel instead.

## Files

| File | Purpose |
|---|---|
| `main.js` | Electron main process: windows, menu, dialogs, file read/write/watch, `state.json`, open-from-Finder handling, `--screenshot` test aid. |
| `preload.js` | The `window.literal` bridge between renderer and main (IPC wrappers only). |
| `src/renderer.js` | The editor: CodeMirror setup, Rendered-mode decorations, list/indent/Enter behaviour, sidebar tree, save/open, Rendered/Raw switch, Find-panel draft. |
| `src/index.html` | Window layout: sidebar, top bar with mode switch, editor, status bar. Loads `out/renderer.js`. |
| `src/styles.css` | Colours (light and dark), sidebar, top bar, status bar, indent guides, whitespace highlight. Editor fonts live in `renderer.js` (see Gotchas). |
| `package.json` | Scripts (`build`, `start`, `package`, `install-app`), electron-builder config (app id, product name, Markdown file associations), dependencies. |
| `package-lock.json` | Locked dependency versions. |
| `out/renderer.js` | esbuild bundle of `src/renderer.js` (generated, gitignored). |
| `dist/mac-arm64/Literal.app` | electron-builder output (generated, gitignored). |

## Runtime locations

| What | Where |
|---|---|
| Installed app | `/Applications/Literal.app` (copied from `dist/mac-arm64/Literal.app` by `npm run install-app`) |
| State (open windows, files, folders, sidebar, Rendered/Raw, Check Spelling) | `~/Library/Application Support/literal-markdown/state.json` |
| Find-panel draft | `localStorage` key `literal.find`, stored by Chromium under `~/Library/Application Support/literal-markdown/Local Storage/` |
| Logs | None. It is a foreground app; errors appear in View > Toggle Developer Tools. |
| Default-app registration | Launch Services, per user (see Settings that matter) |

The folder is named `literal-markdown` (the `name` in `package.json`), not `Literal`, and the development build (`npm start`) and the installed app share it.

## Common tasks

```
npm install                     # once, or after dependencies change
npm start                       # build and launch from source
npm start -- path/to/file.md    # open a file on launch
npm run build                   # just rebuild out/renderer.js (safe while Literal.app is running)
npm run install-app             # build, package and install to /Applications (quit Literal first)
```

`npm run install-app` builds `dist/mac-arm64/Literal.app` and copies it to `/Applications`, strips quarantine
attributes and ad-hoc signs it. The build declares `.md`, `.markdown` and `.mdown` as document types, so Literal
appears in Finder's Open With menu.

Test without touching your files: the main process has a screenshot aid that opens a file, renders it, saves a
PNG and quits, which proves the whole build, open and render path end to end.

```
npm run build && npx electron . path/to/test.md --screenshot=/tmp/literal.png && open /tmp/literal.png
```

Quit Literal.app first: the development build shares `state.json` with it (see Gotchas).

To see what the app is holding in state: `cat ~/Library/Application\ Support/literal-markdown/state.json`.

## Using it

| Action | Shortcut |
|---|---|
| New window | ⌘N |
| Open file / Open folder, in a window of its own | ⌘O / ⇧⌘O |
| Change this window's folder | Open… button at the top of the sidebar |
| Open Recent | File menu; files and folders opened before, kept by macOS |
| Open a sidebar file in a new window | ⌘-click it |
| Save / Save As | ⌘S / ⇧⌘S |
| Rename the open file | File > Rename…, or right-click it in the sidebar |
| Bold / Italic | ⌘B / ⌘I |
| Toggle bullet on the current line(s) | ⇧⌘8 |
| Indent / outdent line(s) | Tab / Shift-Tab |
| Find | ⌘F |
| Toggle sidebar | ⌘\ |
| Rendered / Raw | top bar, or ⌘/ |
| Check spelling | View > Check Spelling (on by default); right-click a marked word for suggestions or Add to Dictionary |
| Open a link | ⌘-click |

File > Open… and Open Folder… never replace what is in front of you: the file or folder opens in a new window, or in the empty window you are looking at, or focuses the window that already shows it, exactly as opening from Finder does. The Open… button at the top of the sidebar is the one way to change which folder the current window shows. Opening a folder shows every file in it as a tree in the sidebar; click a folder to expand or collapse it. Markdown files open in whichever of Rendered or Raw you chose last, other text files always open Raw, and binary files are handed to the app macOS would normally open them with. The sidebar always shows the folder of the open file. Opening a file from Finder focuses the window that already shows it, or opens a new window; opening a folder from Finder (or `open -a Literal somefolder`) shows it in the sidebar of a new window. Right-click any file or folder in the sidebar for Rename…, Open in New Window and Reveal in Finder. Rename turns the name into a text field in place, as in Finder: the name is selected without its extension, Enter or clicking away commits, Escape cancels, and a clash with an existing name is reported in the status bar. A renamed file or folder is followed by every window that has it, or something inside it, open, so unsaved edits are kept and the next save goes to the new name. The `«` button in the sidebar hides it and the `»` button at the top-left brings it back (or ⌘\). Every window's file, folder, expanded folders, sidebar state, size and position are reopened on launch.

Spelling is checked by macOS's own spellchecker (it follows the languages in System Settings), in both Rendered and Raw: a misspelled word gets the usual underline, right-click it for suggestions or **Add to Dictionary**, and View > Check Spelling turns it off for every window. Words added to the dictionary are kept by Chromium in the app's data folder.

In Rendered mode, clicking a checkbox toggles its `[ ]` / `[x]`, Backspace at the start of a heading or quote removes its hidden marker, and image paths are resolved relative to the file. An empty heading or quote line keeps its `#` or `>` visible so no line can be secretly structural.

Enter at the end of a bullet continues the list; Enter on an empty bullet ends it. Enter elsewhere inserts a plain newline with no automatic indentation, so the editor itself never creates whitespace-only lines.

## Working alongside an agent

If the open file changes on disk, the change is folded into the window in place, so an agent (or any other program) editing the same file never collides with you. The editor keeps what you were loaded from, what you have typed and what is now on disk, and merges them line by line:

- Changes to different lines all survive. Your cursor, scroll position and undo history stay put, and undo only ever undoes your own typing.
- With no unsaved edits the file is simply reloaded, again without moving the cursor.
- Where you and the disk changed the same lines, both versions are kept in the text between `<<<<<<< yours (unsaved in editor)`, `======= theirs (on disk)` and `>>>>>>> end of conflict` markers, and the status bar says so. Delete the version you don't want and save.

Nothing is written back until you save, so a save always contains both your edits and the agent's.

## Settings that matter

- **Default Markdown app.** Literal was made the default app for `.md` files on 2026-11-07. Launch Services remembers this per user, independent of rebuilds. To change the default later, right-click a `.md` file in Finder → Get Info → Open with → Change All.
- **Gatekeeper.** The app is ad-hoc signed (`identity: null` in the electron-builder config, then `codesign --sign -` in `install-app`) and `xattr -cr` removes the quarantine flag, so it opens without a developer certificate. If macOS ever refuses to open it after a rebuild, rerun `npm run install-app`.

## Gotchas learned

- **The development build and the installed app share state.** Electron names the user-data folder after `package.json`'s `name` (`literal-markdown`), not the product name, so `npm start` and `/Applications/Literal.app` both read and write the same `state.json`. Running `npm start` or the `--screenshot` test while Literal.app is open makes the second instance restore all of the first one's windows and then overwrite the state file when it quits. Quit Literal first.
- **Rebuilding does not update the running app.** `npm run build` only writes `out/renderer.js`; the installed app runs from its own `app.asar`. Changes to any file, including `package.json`'s `fileAssociations`, reach `/Applications/Literal.app` only after `npm run install-app`, which deletes and replaces the bundle, so do not run it while Literal is open. Whether the installed copy has the document types can be checked with `grep -c CFBundleDocumentTypes /Applications/Literal.app/Contents/Info.plist`.
- **Never put a vertical margin on anything inside a `.cm-line`, including line classes like `.lm-h2`.** CodeMirror's
  height map measures each line's box and knows nothing about margins, so a margin above headings made every click
  land a line or two below where it was aimed, by about 10px per heading above the click. Use padding instead.
- **Fonts and the active line are set in `EditorView.theme` in `renderer.js`, not in `styles.css`**, because CodeMirror's base theme would otherwise win on specificity.
- **The Find draft is replaced on purpose by ⌘F with a selection.** Like every editor, pressing ⌘F with text selected puts the selection in the search field; that overwrites the saved draft. ⌘F with no selection brings the previous search back.
- **Enter never auto-indents.** Automatic indentation is how editors create whitespace-only lines; Literal inserts a plain newline except when continuing a bullet, and `highlightTrailingWhitespace` shows anything that slips through.
- **Hidden markers can trap the cursor.** A line-level marker (`#`, `>`) that is hidden in Rendered mode is removed by Backspace at the start of the line, and an empty heading or quote keeps its marker visible, otherwise a structural line could exist with no visible sign of it.
- **Closing the last window quits the app**, and that window must come back next launch, so `state.json` is only rewritten on close while other windows remain; the final write happens in `before-quit`.
