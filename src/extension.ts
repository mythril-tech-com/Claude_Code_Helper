import * as vscode from 'vscode';

// Internal Claude Code commands. They may change, so they are only ever called defensively.
const FOCUS_CLAUDE = 'claude-vscode.focus';
/** Takes (sessionId, prompt) and opens a new chat with the prompt in its input, without sending it. */
const OPEN_CLAUDE = 'claude-vscode.editor.open';
/** View type suffix of Claude Code's chat when it opens in an editor tab. */
const CLAUDE_PANEL = 'claudeVSCodePanel';

/** Time Claude's input needs to take focus when there is no tab change to wait for. */
const SETTLE_MS = 600;
/** Time the webview needs to read the clipboard after the paste command. */
const PASTE_READ_MS = 200;

let basket: string[] = [];
let statusItem: vscode.StatusBarItem;
let clearTimer: ReturnType<typeof setTimeout> | undefined;

export function activate(context: vscode.ExtensionContext) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.name = 'Claude References';
  statusItem.command = 'claudeAddToChat.clear';

  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand('claudeAddToChat.add', (clicked?: vscode.Uri, selected?: unknown) =>
      addUris(clicked, selected, false)
    ),
    vscode.commands.registerCommand('claudeAddToChat.addToNewChat', (clicked?: vscode.Uri, selected?: unknown) =>
      addUris(clicked, selected, true)
    ),
    vscode.commands.registerCommand('claudeAddToChat.addSelection', () => addSelection(false)),
    vscode.commands.registerCommand('claudeAddToChat.addSelectionToNewChat', () => addSelection(true)),
    vscode.commands.registerCommand('claudeAddToChat.clear', clear),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claudeAddToChat.autoClearSeconds') && basket.length) {
        scheduleAutoClear();
      }
    }),
    { dispose: () => clearTimeout(clearTimer) }
  );
}

export function deactivate() {}

/** The Explorer passes (clicked, allSelected), editor tabs pass (uri, context), the palette passes nothing. */
async function addUris(clicked: vscode.Uri | undefined, selected: unknown, newChat: boolean) {
  let uris = Array.isArray(selected) ? selected.filter((u): u is vscode.Uri => u instanceof vscode.Uri) : [];
  if (!uris.length) {
    const uri = clicked instanceof vscode.Uri ? clicked : vscode.window.activeTextEditor?.document.uri;
    uris = uri ? [uri] : [];
  }

  const refs: string[] = [];
  let skipped = 0;
  for (const uri of uris) {
    const path = workspacePath(uri);
    if (path === undefined) {
      skipped++;
    } else {
      refs.push(`@${path}${(await isDirectory(uri)) ? '/' : ''}`);
    }
  }
  await add(refs, skipped, newChat);
}

async function addSelection(newChat: boolean) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const path = workspacePath(editor.document.uri);
  if (path === undefined) {
    return add([], 1, newChat);
  }
  const refs = [...editor.selections]
    .filter(sel => !sel.isEmpty)
    .sort((a, b) => a.start.compareTo(b.start))
    .map(sel => lineRef(path, sel));
  await add(refs, 0, newChat);
}

/** Workspace-relative path with forward slashes, or undefined for non-file URIs and files outside the workspace. */
function workspacePath(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(uri)) {
    return undefined;
  }
  // The workspace folder itself comes back as an empty string.
  return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/') || '.';
}

async function isDirectory(uri: vscode.Uri): Promise<boolean> {
  try {
    return ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) !== 0;
  } catch {
    return false;
  }
}

function lineRef(path: string, sel: vscode.Selection): string {
  const start = sel.start.line + 1;
  // A selection that ends at column 0 doesn't really include that last line.
  const end = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
  return start === end ? `@${path}#${start}` : `@${path}#${start}-${end}`;
}

async function add(refs: string[], skipped: number, newChat: boolean) {
  if (skipped) {
    void vscode.window.showWarningMessage(
      `Skipped ${skipped} item${skipped === 1 ? '' : 's'}: only files in this workspace can be added to Claude.`
    );
  }
  if (!refs.length) {
    return;
  }

  if (newChat) {
    basket = [];
  }
  const added: string[] = [];
  for (const ref of refs) {
    if (!basket.includes(ref)) {
      basket.push(ref);
      added.push(ref);
    }
  }
  updateStatus();
  scheduleAutoClear();

  if (added.length) {
    await sendToClaude(added.join(' ') + ' ', newChat);
  } else {
    await focusClaude();
  }
  // The whole basket stays on the clipboard as a fallback, with a trailing space so you can type right after pasting.
  await vscode.env.clipboard.writeText(basket.join(' ') + ' ');
}

/** Puts `text` into Claude Code's chat input, starting a new chat when asked to or when no chat is open. */
async function sendToClaude(text: string, newChat: boolean) {
  if (newChat) {
    await openClaudeChat(text);
    return;
  }
  if (!vscode.workspace.getConfiguration('claudeAddToChat').get<boolean>('autoPaste', true)) {
    await focusClaude();
    return;
  }
  const inPanel = vscode.workspace.getConfiguration('claudeCode').get('preferredLocation') !== 'sidebar';
  if (inPanel && !claudeTabs().length && (await openClaudeChat(text))) {
    return;
  }
  const layout = claudeLayout(inPanel);
  if ((await focusClaude()) && (await waitForClaudeInput(layout))) {
    await paste(text);
  }
}

async function hasCommand(command: string): Promise<boolean> {
  try {
    return (await vscode.commands.getCommands(true)).includes(command);
  } catch {
    return false;
  }
}

/** Claude Code fills a new chat's input itself once the chat has loaded, so there is nothing to wait for. */
async function openClaudeChat(text: string): Promise<boolean> {
  if (!(await hasCommand(OPEN_CLAUDE))) {
    return false;
  }
  try {
    await vscode.commands.executeCommand(OPEN_CLAUDE, undefined, text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns whether Claude Code's focus command ran. That command also inserts the active editor's
 * selection into the chat, so the selection is collapsed while it runs to avoid a duplicate mention.
 */
async function focusClaude(): Promise<boolean> {
  if (!(await hasCommand(FOCUS_CLAUDE))) {
    return false;
  }
  const editor = vscode.window.activeTextEditor;
  const saved = editor && !editor.selection.isEmpty ? editor.selections : undefined;
  if (editor && saved) {
    editor.selection = new vscode.Selection(editor.selection.active, editor.selection.active);
  }
  try {
    await vscode.commands.executeCommand(FOCUS_CLAUDE);
    return true;
  } catch {
    // Claude Code changed; the references are still on the clipboard.
    return false;
  } finally {
    if (editor && saved) {
      editor.selections = saved;
    }
  }
}

function isClaudeTab(tab: vscode.Tab | undefined): boolean {
  return tab?.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(CLAUDE_PANEL);
}

function claudeTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(isClaudeTab);
}

/**
 * Where Claude's chat is before we focus it:
 * - beside: visible in another editor group
 * - front: the active editor, while focus is elsewhere (for example the Explorer)
 * - hidden: behind another tab
 * - sidebar: not in an editor tab at all
 */
type Layout = 'beside' | 'front' | 'hidden' | 'sidebar';

function claudeLayout(inPanel: boolean): Layout {
  if (!inPanel) {
    return 'sidebar';
  }
  if (isClaudeTab(vscode.window.tabGroups.activeTabGroup.activeTab)) {
    return 'front';
  }
  return claudeTabs().some(tab => tab.isActive) ? 'beside' : 'hidden';
}

/**
 * Waits until Claude's input should have focus, so the paste lands there and nowhere else.
 * Returns false when Claude's tab never became active, in which case nothing is pasted.
 */
async function waitForClaudeInput(layout: Layout): Promise<boolean> {
  if (layout === 'beside') {
    // VS Code only activates Claude's editor group once its webview has taken focus.
    return waitForActiveClaudeTab(3000);
  }
  if (layout === 'hidden' && !(await waitForActiveClaudeTab(3000))) {
    return false;
  }
  await sleep(SETTLE_MS);
  return true;
}

function waitForActiveClaudeTab(timeoutMs: number): Promise<boolean> {
  const ready = () => isClaudeTab(vscode.window.tabGroups.activeTabGroup.activeTab);
  if (ready()) {
    return Promise.resolve(true);
  }
  return new Promise(resolve => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      listeners.forEach(listener => listener.dispose());
      resolve(ok);
    };
    const check = () => {
      if (ready()) {
        done(true);
      }
    };
    const listeners = [
      vscode.window.tabGroups.onDidChangeTabGroups(check),
      vscode.window.tabGroups.onDidChangeTabs(check),
    ];
    const timer = setTimeout(() => done(false), timeoutMs);
  });
}

/** Acts like Ctrl+V: VS Code sends its paste command to the focused webview, which is Claude's input by now. */
async function paste(text: string) {
  try {
    await vscode.env.clipboard.writeText(text);
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    await sleep(PASTE_READ_MS);
  } catch {
    // The full basket is copied afterwards, so Ctrl+V still works.
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clear() {
  basket = [];
  clearTimeout(clearTimer);
  clearTimer = undefined;
  updateStatus();
}

function scheduleAutoClear() {
  clearTimeout(clearTimer);
  const seconds = vscode.workspace.getConfiguration('claudeAddToChat').get<number>('autoClearSeconds', 120);
  clearTimer = seconds > 0 ? setTimeout(clear, seconds * 1000) : undefined;
}

function updateStatus() {
  if (!basket.length) {
    statusItem.hide();
    return;
  }
  statusItem.text = `$(mention) ${basket.length} ref${basket.length === 1 ? '' : 's'}`;
  statusItem.tooltip = `${basket.join('\n')}\n\nClick to clear`;
  statusItem.show();
}
