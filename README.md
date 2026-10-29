# Claude Add to Chat

Add file, folder and line references to the Claude Code chat, similar to Cursor's "Add to chat".

## Usage

| Command | Where | Result |
| --- | --- | --- |
| **Add to Claude** | Right-click files or folders in the Explorer (multi-select works), or right-click an editor tab | Adds `@src/utils/helper.ts` or `@src/components/` to the open Claude chat |
| **Add to New Claude Chat** | Same menus | Opens a new Claude chat with the references already typed in |
| **Add Selection to Claude** | Right-click selected text, or press `Ctrl+L` / `Cmd+L` | Adds `@src/app.ts#42` or `@src/app.ts#5-10` to the open Claude chat |
| **Add Selection to New Claude Chat** | Right-click selected text | Opens a new Claude chat with the line references typed in |
| **Clear Claude References** | Command Palette, or click the `@ 3 refs` status bar item | Empties the basket |

- If no Claude chat is open, **Add to Claude** opens a new one with the references typed in.
- Nothing is sent to Claude. Add references from as many files as you like, then type your question.
- Paths are relative to the workspace and use forward slashes.
- Each multi-cursor selection becomes its own reference.
- A selection that ends at the start of a line doesn't include that line.
- Untitled files, files that aren't on disk and files outside the workspace are skipped with a warning.

Everything you have added recently also stays on the clipboard as a **basket**. Press `Ctrl+V` (`Cmd+V` on Mac) in Claude's chat if a reference ever doesn't show up, or to reuse the list in another chat.

> **Note:** `Ctrl+L` / `Cmd+L` overrides VS Code's built-in **Expand Line Selection** while text is selected. To change this, open Keyboard Shortcuts and rebind `claudeAddToChat.addSelection`.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeAddToChat.autoPaste` | `true` | **Add to Claude** puts new references straight into the open chat. Turn off to paste them yourself with `Ctrl+V`. |
| `claudeAddToChat.autoClearSeconds` | `120` | Clears the basket after this many seconds without a new add. `0` means never. |

## How it works

Claude Code has no public API for adding text to its chat, so this extension uses two of Claude Code's internal commands. They may change in a future Claude Code update. If one is missing or fails, the references are still on your clipboard.

- **New chat:** `claude-vscode.editor.open` accepts a starting prompt. Claude Code types it into the new chat once the chat has loaded.
- **Open chat:** `claude-vscode.focus` focuses Claude's input. The extension waits until the input has focus, then runs VS Code's built-in paste command, which goes to the focused chat. When Claude's chat is visible next to your code, VS Code signals exactly when it takes focus. When the chat is behind another tab, the extension waits a short, fixed time after the tab comes forward.

`claude-vscode.focus` also inserts the active editor's selection into the chat by itself. To avoid duplicates, the extension briefly collapses that selection while the command runs, then restores it.

The extension makes no network requests, collects no telemetry and never reads file contents.

## Build

Requires Node.js 20 or later.

```sh
npm install
npm run compile
npm run package
```

`npm run package` runs `npx @vscode/vsce package` and creates `claude-add-to-chat-<version>.vsix`.

## Install

1. Open the Extensions view (`Ctrl+Shift+X`).
2. Click the **...** menu at the top of the view.
3. Choose **Install from VSIX...** and pick the `.vsix` file.

Or from a terminal: `code --install-extension claude-add-to-chat-0.0.3.vsix`

Installing a newer `.vsix` replaces the old version. Reload the window afterwards.
