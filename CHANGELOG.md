# Changelog

## 0.1.2

- No longer marked as Preview. The extension still relies on Claude Code's internal commands, as [How it works](https://github.com/mythril-tech-com/Claude_Code_Helper#how-it-works) explains, and the references stay on the clipboard if one of them fails.

## 0.1.1

- Also on [Open VSX](https://open-vsx.org/extension/mythriltech/claude-code-add-to-chat), where Cursor, Antigravity, Windsurf and other editors built on VS Code get their extensions. The README now says so.
- The README's install example no longer names a specific version.

## 0.1.0

First Marketplace release. Renamed from **Claude Add to Chat** to **Claude Code - Add to Chat**.

- **Add to Claude** and **Add to New Claude Chat** from the Explorer and editor tab context menus, for files and folders.
- **Add Selection to Claude** (`Ctrl+L` / `Cmd+L`) and **Add Selection to New Claude Chat** for line references.
- Adds to Claude's Side Bar chat by default, with optional **(Tab)** commands for Claude's chat in an editor tab.
- **Drop Files for Claude** strip under Claude's Side Bar chat, since dropping files onto the chat itself no longer works.
- Clipboard basket of recent references, with a status bar item to clear it.
- Settings: `claudeAddToChat.autoPaste`, `claudeAddToChat.autoClearSeconds`, `claudeAddToChat.showTabOptions`.

Earlier 0.0.x versions were private `.vsix` builds.
