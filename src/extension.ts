import * as vscode from 'vscode';

// Internal Claude Code commands. They may change, so they are only ever called defensively.
const FOCUS_CLAUDE = 'claude-vscode.focus';
/** Takes (sessionId, prompt) and opens a new chat with the prompt in its input, without sending it. */
const OPEN_CLAUDE = 'claude-vscode.editor.open';
/** Claude Code's own Alt+K: mentions the active editor's selection, or its whole file when nothing is selected. */
const MENTION_CLAUDE = 'claude-vscode.insertAtMention';
/** View type suffix of Claude Code's chat when it opens in an editor tab. */
const CLAUDE_PANEL = 'claudeVSCodePanel';
/** Claude Code's sidebar chat views: in the Secondary Side Bar, or in the Activity Bar on VS Code before 1.106. */
const CLAUDE_SIDEBAR_VIEWS = ['claudeVSCodeSidebarSecondary', 'claudeVSCodeSidebar'];
/** Our drop strip, one per Claude sidebar container, in the same order. */
const DROP_VIEWS = ['claudeAddToChat.dropSecondary', 'claudeAddToChat.drop'];

/** Time Claude's input needs to take focus when there is no tab change to wait for. */
const SETTLE_MS = 600;
/** Time the webview needs to read the clipboard after the paste command. */
const PASTE_READ_MS = 200;
/** Time Claude's sidebar chat needs to load after its sidebar opens, before its input can take focus. */
const COLD_SETTLE_MS = 1500;
/** Longest wait for Claude's sidebar to open. */
const SIDEBAR_OPEN_MS = 3000;

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
/** Whether the Side Bar options are on, see activate. */
let sidebarOn = false;
let dropViews: vscode.TreeView<DropTarget>[] = [];

export function activate(context: vscode.ExtensionContext) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.name = 'Claude References';
  statusItem.command = 'claudeAddToChat.clear';

  // CLAUDE_ADD_TO_CHAT_SIDEBAR=false hides the Side Bar commands and the drop strip. The strip also needs Claude
  // Code installed, because VS Code moves views whose container is missing into the Explorer.
  sidebarOn =
    process.env.CLAUDE_ADD_TO_CHAT_SIDEBAR !== 'false' && !!vscode.extensions.getExtension('anthropic.claude-code');
  void vscode.commands.executeCommand('setContext', 'claudeAddToChat.sidebar', sidebarOn);
  if (sidebarOn) {
    const strip = new DropStrip();
    dropViews = DROP_VIEWS.map(id =>
      vscode.window.createTreeView(id, { treeDataProvider: strip, dragAndDropController: strip })
    );
    context.subscriptions.push(...dropViews);
    void makeSidebarDefault();
  }

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
    vscode.commands.registerCommand('claudeAddToChat.addToSidebar', (clicked?: vscode.Uri, selected?: unknown) =>
      addUris(clicked, selected, false, true)
    ),
    vscode.commands.registerCommand(
      'claudeAddToChat.addToNewSidebarChat',
      (clicked?: vscode.Uri, selected?: unknown) => addUris(clicked, selected, true, true)
    ),
    vscode.commands.registerCommand('claudeAddToChat.addSelectionToSidebar', () => addSelection(false, true)),
    vscode.commands.registerCommand('claudeAddToChat.addSelectionToNewSidebarChat', () => addSelection(true, true)),
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
async function addUris(clicked: vscode.Uri | undefined, selected: unknown, newChat: boolean, sidebar = false) {
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
  await add(refs, skipped, newChat, sidebar);
}

async function addSelection(newChat: boolean, sidebar = false) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const path = workspacePath(editor.document.uri);
  if (path === undefined) {
    return add([], 1, newChat, sidebar);
  }
  const refs = [...editor.selections]
    .filter(sel => !sel.isEmpty)
    .sort((a, b) => a.start.compareTo(b.start))
    .map(sel => ({
      text: lineRef(path, sel),
      selection: mentionable(path) ? mentionSelection(editor.document, sel) : undefined,
    }));
  await add(refs, 0, newChat, sidebar);
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

async function add(refs: Ref[], skipped: number, newChat: boolean, sidebar = false) {
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
    await (sidebar ? sendToSidebar(added, newChat) : sendToClaude(added, newChat));
  } else {
    await (sidebar ? focusSidebarInput() : focusClaude());
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

/**
 * Claude Code fills a new chat's input itself once the chat has loaded, so there is nothing to wait for. Opening a tab
 * normally switches Claude's location setting back to tabs; with the Side Bar options on, `pin-to-panel` opens the tab
 * without that, so Claude's own buttons keep opening the sidebar.
 */
async function openClaudeChat(text: string): Promise<boolean> {
  if (!(await hasCommand(OPEN_CLAUDE))) {
    return false;
  }
  try {
    const options = sidebarOn ? [undefined, undefined, undefined, { programmatic: 'pin-to-panel' }] : [];
    await vscode.commands.executeCommand(OPEN_CLAUDE, undefined, text, ...options);
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

/**
 * Puts `refs` into Claude Code's sidebar chat only. Claude Code's mention command reaches every visible chat, so this
 * focuses the sidebar chat's input and pastes.
 */
async function sendToSidebar(refs: Ref[], newChat: boolean) {
  const text = refs.map(ref => ref.text).join(' ') + ' ';
  if (newChat) {
    await openSidebarChat(text);
    return;
  }
  if (
    (await focusSidebarInput()) &&
    vscode.workspace.getConfiguration('claudeAddToChat').get<boolean>('autoPaste', true)
  ) {
    await pasteIntoSidebar(text);
  }
}

/**
 * Claude Code opens a new chat in its sidebar, with the prompt in its input, only for a programmatic request while
 * its location setting says sidebar. It reads that setting on each call, so the setting is switched for this call
 * only. Claude Code holds the prompt until the sidebar chat has loaded, so there is nothing to wait for.
 */
async function openSidebarChat(text: string) {
  if (!(await hasCommand(OPEN_CLAUDE))) {
    return;
  }
  const restore = await preferSidebar();
  try {
    await vscode.commands.executeCommand(OPEN_CLAUDE, undefined, text, undefined, undefined, undefined, {
      programmatic: 'honor-preferred-location',
    });
  } catch {
    // Claude Code changed; the references are still on the clipboard.
  } finally {
    await restore();
  }
}

function isSidebarPreferred(): boolean {
  return vscode.workspace.getConfiguration('claudeCode').get('preferredLocation') === 'sidebar';
}

/** Claude's location setting at the level it is set at: the workspace when that sets it, the user settings otherwise. */
function locationSetting() {
  const info = vscode.workspace.getConfiguration('claudeCode').inspect<string>('preferredLocation');
  const inWorkspace = info?.workspaceValue !== undefined;
  const target = inWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  return {
    value: inWorkspace ? info?.workspaceValue : info?.globalValue,
    // undefined removes the key again.
    set: (value: string | undefined) =>
      vscode.workspace.getConfiguration('claudeCode').update('preferredLocation', value, target),
  };
}

/**
 * Makes Claude Code open in its sidebar, so its own buttons show the sidebar chat and the drop strip under it. Claude
 * Code switches back to tabs when you open it in a new tab yourself; that holds until the next start.
 */
async function makeSidebarDefault() {
  if (isSidebarPreferred()) {
    return;
  }
  try {
    await locationSetting().set('sidebar');
  } catch {
    // Claude Code keeps opening in tabs.
  }
}

/** Sets Claude's location setting to sidebar for one call, and returns a function that undoes that. */
async function preferSidebar(): Promise<() => Promise<void>> {
  if (isSidebarPreferred()) {
    return async () => {};
  }
  const setting = locationSetting();
  try {
    await setting.set('sidebar');
  } catch {
    return async () => {};
  }
  await waitUntil(isSidebarPreferred, [vscode.workspace.onDidChangeConfiguration], 1000);
  return async () => {
    try {
      await setting.set(setting.value);
    } catch {
      // Nothing more to try; Claude Code would then open new chats in its sidebar.
    }
  };
}

/**
 * Focuses Claude's sidebar chat with VS Code's own view command. Unlike Claude Code's commands, it doesn't change
 * Claude's location setting. Claude Code moved its chat to the Secondary Side Bar in VS Code 1.106, and VS Code
 * quietly ignores a focus command for the view that isn't in use, so the view is picked by version, as Claude Code does.
 */
async function focusSidebar(): Promise<boolean> {
  const [major, minor] = vscode.version.split('.').map(Number);
  const view = major > 1 || (major === 1 && minor >= 106) ? CLAUDE_SIDEBAR_VIEWS[0] : CLAUDE_SIDEBAR_VIEWS[1];
  try {
    await vscode.commands.executeCommand(`${view}.focus`);
    return true;
  } catch {
    return false;
  }
}

/** The drop strip lives in Claude's sidebar, so it is visible exactly when that sidebar is open. */
function isSidebarOpen(): boolean {
  return dropViews.some(view => view.visible);
}

/**
 * Opens Claude's sidebar chat and returns once the cursor should be in its input, or false when the sidebar can't be
 * opened. Focusing the view returns focus to whatever the chat last had focused, which in a chat this extension didn't
 * start can be something other than the input. Claude Code's own focus command always puts the cursor in the input,
 * but it reaches every visible Claude chat, so with a Claude tab in view the view is focused again instead.
 */
async function focusSidebarInput(): Promise<boolean> {
  const wasOpen = isSidebarOpen();
  if (!(await focusSidebar())) {
    return false;
  }
  if (!wasOpen) {
    // A chat that is still loading can't take focus yet, and Claude Code would open a tab for a focus request that
    // no visible chat takes. Goes on even if the strip never shows, for example when it is collapsed.
    await waitUntil(isSidebarOpen, dropViews.map(view => view.onDidChangeVisibility), SIDEBAR_OPEN_MS);
    await sleep(COLD_SETTLE_MS);
  }
  if (claudeTabs().some(tab => tab.isActive) || !(await focusClaude())) {
    await focusSidebar();
  }
  await sleep(SETTLE_MS);
  return true;
}

/** Like paste, but takes the paste back when it lands in a text editor because Claude's chat didn't have focus. */
async function pasteIntoSidebar(text: string) {
  let missed: vscode.TextDocument | undefined;
  const listener = vscode.workspace.onDidChangeTextDocument(e => {
    if (e.document === vscode.window.activeTextEditor?.document && e.contentChanges.some(c => c.text === text)) {
      missed = e.document;
    }
  });
  try {
    await paste(text);
  } finally {
    listener.dispose();
  }
  if (!missed) {
    return;
  }
  if (vscode.window.activeTextEditor?.document === missed) {
    await vscode.commands.executeCommand('undo');
  }
  void vscode.window.showWarningMessage(
    "Claude's sidebar chat wasn't ready. The references are on the clipboard; press Ctrl+V in the chat."
  );
}

/** Resolves true once `ready()` holds, checked whenever one of `events` fires, or false after `timeoutMs`. */
function waitUntil(ready: () => boolean, events: vscode.Event<unknown>[], timeoutMs: number): Promise<boolean> {
  if (ready()) {
    return Promise.resolve(true);
  }
  return new Promise(resolve => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      listeners.forEach(listener => listener.dispose());
      resolve(ok);
    };
    const listeners = events.map(event =>
      event(() => {
        if (ready()) {
          done(true);
        }
      })
    );
    const timer = setTimeout(() => done(false), timeoutMs);
  });
}

/** A row of the drop strip. */
interface DropTarget {
  label: string;
  tooltip: string;
  icon: string;
  newChat: boolean;
}

const DROP_TARGETS: DropTarget[] = [
  {
    label: 'Drop here → add to chat',
    tooltip: "Drop files or folders here to add them to Claude's sidebar chat.",
    icon: 'mention',
    newChat: false,
  },
  {
    label: 'Drop here → new chat',
    tooltip: 'Drop files or folders here to start a new Claude sidebar chat with them.',
    icon: 'add',
    newChat: true,
  },
];

/**
 * A small tree view under Claude's sidebar chat that takes file drops. VS Code 1.140 and later don't pass drags to
 * Claude's chat webview, but native views still get them, without Shift.
 */
class DropStrip implements vscode.TreeDataProvider<DropTarget>, vscode.TreeDragAndDropController<DropTarget> {
  readonly dropMimeTypes = ['text/uri-list'];
  readonly dragMimeTypes: string[] = [];

  getTreeItem(target: DropTarget): vscode.TreeItem {
    const item = new vscode.TreeItem(target.label);
    item.tooltip = target.tooltip;
    item.iconPath = new vscode.ThemeIcon(target.icon);
    return item;
  }

  getChildren(target?: DropTarget): DropTarget[] {
    return target ? [] : DROP_TARGETS;
  }

  /** A drop below the rows has no target and adds to the open chat. */
  async handleDrop(target: DropTarget | undefined, data: vscode.DataTransfer) {
    const uris = parseUriList(await data.get('text/uri-list')?.asString());
    // An empty list would make addUris fall back to the active editor.
    if (uris.length) {
      await addUris(undefined, uris, target?.newChat ?? false, true);
    }
  }
}

/** text/uri-list holds one URI per line; lines starting with # are comments. */
function parseUriList(list: string | undefined): vscode.Uri[] {
  const uris: vscode.Uri[] = [];
  for (const line of list?.split(/\r?\n/) ?? []) {
    const value = line.trim();
    if (!value || value.startsWith('#')) {
      continue;
    }
    try {
      uris.push(vscode.Uri.parse(value, true));
    } catch {
      // Not a URI.
    }
  }
  return uris;
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
