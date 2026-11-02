# Claude Code - Add to Chat

Add file, folder and line references to the Claude Code chat, similar to Cursor's "Add to chat". Right-click files in the Explorer, drop them under the chat, or press `Ctrl+L` on selected lines.

Requires the Claude Code extension ([VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code), [Open VSX](https://open-vsx.org/extension/Anthropic/claude-code)). In Cursor, Antigravity, Windsurf and other editors built on VS Code, install this extension from [Open VSX](https://open-vsx.org/extension/mythriltech/claude-code-add-to-chat).

The extension makes no network requests, collects no telemetry and never reads file contents.

## Usage

| Command | Where | Result |
| --- | --- | --- |
| **Add to Claude** | Right-click files or folders in the Explorer (multi-select works), or right-click an editor tab | Adds `@src/utils/helper.ts` or `@src/components/` to Claude's Side Bar chat |
| **Add to New Claude Chat** | Same menus | Opens a new Side Bar chat with the references already typed in |
| **Add Selection to Claude** | Right-click selected text, or press `Ctrl+L` / `Cmd+L` | Adds `@src/app.ts#42` or `@src/app.ts#5-10` to the Side Bar chat |
| **Add Selection to New Claude Chat** | Right-click selected text | Opens a new Side Bar chat with the line references typed in |
| **Clear Claude References** | Command Palette, or click the `@ 3 refs` status bar item | Empties the basket |

- Nothing is sent to Claude. Add references from as many files as you like, then type your question.
- The commands open Claude's Side Bar chat if it's closed. To use Claude's chat in an editor tab instead, turn on `claudeAddToChat.showTabOptions`.
- Everything you added recently stays on the clipboard as a **basket**. If a reference doesn't show up, press `Ctrl+V` (`Cmd+V` on Mac) in Claude's chat.

> **Note:** `Ctrl+L` / `Cmd+L` replaces VS Code's **Expand Line Selection** while text is selected. You can rebind it in Keyboard Shortcuts.

## Drag and drop

Since VS Code 1.140, dropping files onto Claude Code's chat does nothing ([anthropics/claude-code#25128](https://github.com/anthropics/claude-code/issues/25128)). So the extension adds a **Drop Files for Claude** strip under Claude's Side Bar chat. Drag files and folders onto it from the Explorer or your file manager, no Shift needed:

- **Drop here → add to chat** adds them to the open chat.
- **Drop here → new chat** starts a new chat with them.

The strip starts at half the Side Bar's height. Drag the divider above it down once and VS Code remembers the size. To remove the strip, right-click its title and choose **Hide**.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeAddToChat.autoPaste` | `true` | **Add to Claude** puts the references straight into the open chat. Turn off to paste them yourself with `Ctrl+V`. |
| `claudeAddToChat.autoClearSeconds` | `120` | Clears the basket after this many seconds without a new add. `0` means never. |
| `claudeAddToChat.showTabOptions` | `false` | Also shows the **(Tab)** commands, which add to Claude's chat in an editor tab. |

When VS Code starts, the extension sets Claude Code's **Preferred Location** (`claudeCode.preferredLocation`) to `sidebar`, so Claude's own buttons also open the Side Bar chat with the drop strip under it.

## More

This extension uses Claude Code's internal commands, which a Claude Code update could change. If one fails, your references are still on the clipboard. [Details](docs/DETAILS.md) covers how it works, turning off the Side Bar options, building it and installing a `.vsix`.
