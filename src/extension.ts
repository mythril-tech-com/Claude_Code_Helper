import * as vscode from 'vscode';

// Internal Claude Code commands. They may change, so they are only ever called defensively.
const FOCUS_CLAUDE = 'claude-vscode.focus';
/** Takes (sessionId, prompt) and opens a new chat with the prompt in its input, without sending it. */
const OPEN_CLAUDE = 'claude-vscode.editor.open';
/** Claude Code's own Alt+K: mentions the active editor's selection, or its whole file when nothing is selected. */
const MENTION_CLAUDE = 'claude-vscode.insertAtMention';
/** View type suffix of Claude Code's chat when it opens in an editor tab. */
const CLAUDE_PANEL = 'claudeVSCodePanel';

/** Time Claude's input needs to take focus when there is no tab change to wait for. */
const SETTLE_MS = 600;
/** Time the webview needs to read the clipboard after the paste command. */
const PASTE_READ_MS = 200;

/**
 * A reference, plus the active editor selection that makes Claude Code's mention command produce it.
 * Folders and files that aren't the active editor have no such selection and can only be pasted.
 */
interface Ref {
  text: string;
  selection?: vscode.Selection;
}

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

  const refs: Ref[] = [];
  let skipped = 0;
  for (const uri of uris) {
    const path = workspacePath(uri);
    if (path === undefined) {
      skipped++;
    } else if (await isDirectory(uri)) {
      refs.push({ text: `@${path}/` });
    } else {
      refs.push({ text: `@${path}`, selection: wholeFileSelection(uri, path) });
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
    .map(sel => ({
      text: lineRef(path, sel),
      selection: mentionable(path) ? mentionSelection(editor.document, sel) : undefined,
    }));
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

/** Claude Code refuses to mention these paths, because it would read them as a different mention. */
function mentionable(path: string): boolean {
  return !/[#"]/.test(path);
}

/** An empty selection makes Claude Code mention the whole file, but only for the active editor. */
function wholeFileSelection(uri: vscode.Uri, path: string): vscode.Selection | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== uri.toString() || !mentionable(path)) {
    return undefined;
  }
  return new vscode.Selection(editor.selection.active, editor.selection.active);
}

/** The lines of lineRef as a selection for Claude Code, which counts a selection ending at column 0 as including that line. */
function mentionSelection(document: vscode.TextDocument, sel: vscode.Selection): vscode.Selection | undefined {
  if (!(sel.end.character === 0 && sel.end.line > sel.start.line)) {
    return sel;
  }
  const end = document.lineAt(sel.end.line - 1).range.end;
  // When only a line break is selected, no non-empty selection covers just that line.
  return end.isAfter(sel.start) ? new vscode.Selection(sel.start, end) : undefined;
}

async function add(refs: Ref[], skipped: number, newChat: boolean) {
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
  const added: Ref[] = [];
  for (const ref of refs) {
    if (!basket.includes(ref.text)) {
      basket.push(ref.text);
      added.push(ref);
    }
  }
  updateStatus();
  scheduleAutoClear();

  if (added.length) {
    await sendToClaude(added, newChat);
  } else {
    await focusClaude();
  }
  // The whole basket stays on the clipboard as a fallback, with a trailing space so you can type right after pasting.
  await vscode.env.clipboard.writeText(basket.join(' ') + ' ');
}

/** Puts `refs` into Claude Code's chat input, starting a new chat when asked to or when no chat is open. */
async function sendToClaude(refs: Ref[], newChat: boolean) {
  const text = refs.map(ref => ref.text).join(' ') + ' ';
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
  if (await mentionInClaude(refs)) {
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
 * Inserts the references with Claude Code's own mention command, which hands each one to the chat, revealing it if
 * hidden, without the clipboard or any waiting for focus. The command only reads the active editor's selection, so
 * this works only when every reference has one. Claude Code keeps just one mention for a chat that isn't open yet,
 * which is why a missing chat tab is opened before this runs.
 */
async function mentionInClaude(refs: Ref[]): Promise<boolean> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !refs.every(ref => ref.selection) || !(await hasCommand(MENTION_CLAUDE))) {
    return false;
  }
  const saved = editor.selections;
  let sent = 0;
  try {
    for (const ref of refs) {
      editor.selection = ref.selection!;
      await vscode.commands.executeCommand(MENTION_CLAUDE);
      sent++;
    }
  } catch {
    // Claude Code changed. If it failed partway, the rest are still on the clipboard.
  } finally {
    editor.selections = saved;
  }
  return sent > 0;
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
