# Claude Add to Chat

Add file, folder and line references to the Claude Code chat, similar to Cursor's "Add to chat".

## Usage

| Command | Where | Result |
| --- | --- | --- |
| **Add to Claude** | Right-click files or folders in the Explorer (multi-select works), or right-click an editor tab | Adds `@src/utils/helper.ts` or `@src/components/` to Claude's Side Bar chat |
| **Add to New Claude Chat** | Same menus | Opens a new Side Bar chat with the references already typed in |
| **Add Selection to Claude** | Right-click selected text, or press `Ctrl+L` / `Cmd+L` | Adds `@src/app.ts#42` or `@src/app.ts#5-10` to the Side Bar chat |
| **Add Selection to New Claude Chat** | Right-click selected text | Opens a new Side Bar chat with the line references typed in |
| **Clear Claude References** | Command Palette, or click the `@ 3 refs` status bar item | Empties the basket |

- The commands use Claude's Side Bar chat even when a Claude tab is open too, and open the Side Bar when it's closed.
- To add to Claude's chat in an editor tab instead, turn on `claudeAddToChat.showTabOptions`. The menus then also show **Add to Claude (Tab)**, **Add to New Claude Chat (Tab)** and the two **Add Selection … (Tab)** commands. If no Claude tab is open, **Add to Claude (Tab)** opens one with the references typed in.
- Adding a file again adds it again, for example to a new chat you started with Claude Code's own New Chat button.
- Nothing is sent to Claude. Add references from as many files as you like, then type your question.
- Paths are relative to the workspace and use forward slashes.
- Each multi-cursor selection becomes its own reference.
- A selection that ends at the start of a line doesn't include that line.
- Untitled files, files that aren't on disk and files outside the workspace are skipped with a warning.

Everything you have added recently also stays on the clipboard as a **basket**. Press `Ctrl+V` (`Cmd+V` on Mac) in Claude's chat if a reference ever doesn't show up, or to reuse the list in another chat.

> **Note:** `Ctrl+L` / `Cmd+L` overrides VS Code's built-in **Expand Line Selection** while text is selected. To change this, open Keyboard Shortcuts and rebind `claudeAddToChat.addSelectionToSidebar` (`claudeAddToChat.addSelection` with the Side Bar options off).

## Drag and drop

Since VS Code 1.140, dropping files onto Claude Code's chat does nothing, with or without Shift ([anthropics/claude-code#25128](https://github.com/anthropics/claude-code/issues/25128)). VS Code stops the drag before Claude's chat sees it, so neither this extension nor Claude Code can fix that inside the chat.

VS Code's own views still accept drops, so the extension adds a **Drop Files for Claude** strip under Claude's Side Bar chat. Drag files and folders onto it from the Explorer or from your file manager. No Shift needed.

- **Drop here → add to chat** adds the references to the Side Bar chat, like **Add to Claude**.
- **Drop here → new chat** starts a new Side Bar chat with them, like **Add to New Claude Chat**.

The strip starts at half the Side Bar's height, because VS Code doesn't let an extension size a view inside another extension's Side Bar. Drag the divider above it down once; VS Code remembers that size for each workspace. To remove the strip, right-click its title and choose **Hide**.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeAddToChat.autoPaste` | `true` | **Add to Claude** puts the references straight into the open chat. Turn off to paste them yourself with `Ctrl+V`. |
| `claudeAddToChat.autoClearSeconds` | `120` | Clears the basket after this many seconds without a new add. `0` means never. |
| `claudeAddToChat.showTabOptions` | `false` | Also shows the **(Tab)** commands, which add to Claude's chat in an editor tab. |

The extension sets Claude Code's **Preferred Location** setting (`claudeCode.preferredLocation`) to `sidebar` when VS Code starts, at the level where you have it set (User or Workspace). Claude Code's own buttons, the ✱ in the editor title bar and **✻ Claude Code** in the status bar, then open the Side Bar chat with the drop strip under it. **Add to New Claude Chat (Tab)** opens a tab and leaves the setting as it is. Claude Code's **Open in New Tab** (`Ctrl+Shift+Esc`) switches the setting back to tabs, and it stays that way until VS Code starts again.

To turn off the Side Bar options, set the environment variable `CLAUDE_ADD_TO_CHAT_SIDEBAR` to `false`, for example with `setx CLAUDE_ADD_TO_CHAT_SIDEBAR false` on Windows. Then close every VS Code window and start VS Code again, because VS Code reads environment variables only when it starts. The drop strip goes away, the extension leaves Claude's **Preferred Location** alone, and the four commands add to Claude's chat wherever it opens, as in version 0.0.4. The only difference from 0.0.4 is that adding a reference again adds it again. The Side Bar options are also off when Claude Code isn't installed.

## How it works

Claude Code has no public API for adding text to its chat, so this extension uses three of Claude Code's internal commands. They may change in a future Claude Code update. If one is missing or fails, the references are still on your clipboard.

The **(Tab)** commands, and all commands with the Side Bar options off:

- **New chat:** `claude-vscode.editor.open` accepts a starting prompt. Claude Code types it into the new chat once the chat has loaded. With the Side Bar options on, the request is marked `pin-to-panel`, which opens the tab without switching Claude's **Preferred Location** back to tabs.
- **Selections and the active file, open chat:** `claude-vscode.insertAtMention` is Claude Code's own **Insert @-Mention Reference** (`Alt+K`). It only mentions the active editor's selection, so the extension selects each range in turn, runs the command, then restores your selection. Claude Code hands the mention straight to its chat, even one behind another tab. If several Claude chats are visible, each one gets it.
- **Other files and folders, open chat:** `claude-vscode.focus` focuses Claude's input. The extension waits until the input has focus, then runs VS Code's built-in paste command, which goes to the focused chat. When Claude's chat is visible next to your code, VS Code signals exactly when it takes focus. When the chat is behind another tab, the extension waits a short, fixed time after the tab comes forward.

`claude-vscode.focus` also inserts the active editor's selection into the chat by itself. To avoid duplicates, the extension briefly collapses that selection while the command runs, then restores it.

The Side Bar commands can't use Claude Code's mention command, because it reaches every visible Claude chat:

- **New Side Bar chat:** `claude-vscode.editor.open` opens its new chat in the Side Bar only when the request is marked `honor-preferred-location` and Claude's **Preferred Location** setting is `sidebar`. If you switched it back to tabs, the extension sets it to `sidebar` for that one call and then puts back the value you had, at the same level (User or Workspace). Claude Code reads the setting only at that moment, so nothing else notices the change.
- **Open Side Bar chat:** VS Code's own `claudeVSCodeSidebarSecondary.focus` command (`claudeVSCodeSidebar.focus` before VS Code 1.106) opens the Side Bar chat, and leaves Claude's setting alone. When the Side Bar was closed, the extension waits for Claude's chat to load. That focuses the chat, but not always its input: a chat you started with Claude's own New Chat button, or clicked in, can keep focus elsewhere. So when no Claude tab is in view, `claude-vscode.focus` then puts the cursor in the Side Bar chat's input. With a Claude tab in view, that command would reach the tab too, so the Side Bar view is focused again instead. The extension then pastes, like above. If the paste lands in your code instead, it's undone and a message tells you to press `Ctrl+V` in the chat.
- **Drop strip:** a small VS Code view placed in Claude Code's own Side Bar container. Its being visible is also how the extension knows that Claude's Side Bar is open.

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

Or from a terminal: `code --install-extension claude-add-to-chat-0.0.8.vsix`

Installing a newer `.vsix` replaces the old version. Reload the window afterwards.
