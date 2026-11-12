import * as path from 'path';
import * as vscode from 'vscode';
import { MachinesProvider, MachineItem, ProjectItem } from './tree';
import { Machine, stream } from './vagrant';
import { DetailsPanel } from './detailsPanel';
import { TopologyPanel } from './topologyPanel';

type Target = MachineItem | ProjectItem;

let output: vscode.OutputChannel;
const busy = new Set<string>();

/**
 * Normaliza o argumento dos comandos: vem como item da árvore (menus) ou
 * como objeto JSON simples (links do card de tooltip).
 */
function toTarget(arg: unknown): Target | undefined {
  if (arg instanceof MachineItem || arg instanceof ProjectItem) {
    return arg;
  }
  if (arg && typeof arg === 'object') {
    const o = arg as Partial<Machine>;
    if (typeof o.cwd === 'string' && typeof o.name === 'string') {
      return new MachineItem(o as Machine);
    }
    if (typeof o.cwd === 'string') {
      return new ProjectItem(o.cwd, false);
    }
  }
  return undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Vagrant Explorer');
  const provider = new MachinesProvider();

  const view = vscode.window.createTreeView('vagrantManager.machines', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  // Status bar: VMs rodando / total, segundo o global-status.
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = 'workbench.view.extension.vagrantManager';
  statusItem.name = 'Vagrant Explorer';
  provider.onDidLoadGlobal((entries) => {
    const running = entries.filter((e) => e.state === 'running').length;
    statusItem.text = `$(vm) ${running}/${entries.length}`;
    statusItem.tooltip = vscode.l10n.t('Vagrant: {0} VM(s) running out of {1} known', running, entries.length);
    statusItem.show();
    view.badge = running > 0 ? { value: running, tooltip: vscode.l10n.t('{0} VM(s) running', running) } : undefined;
  });

  const run = (sub: string, opts: { confirm?: string; extraArgs?: string[] } = {}) => async (arg?: unknown) => {
    const t = toTarget(arg);
    if (!t) {
      vscode.window.showWarningMessage(vscode.l10n.t('Use this command from the Vagrant view.'));
      return;
    }
    await runVagrant(provider, t, sub, opts);
  };

  context.subscriptions.push(
    output,
    view,
    statusItem,
    vscode.commands.registerCommand('vagrantManager.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('vagrantManager.showOutput', () => output.show()),
    vscode.commands.registerCommand('vagrantManager.up', run('up')),
    vscode.commands.registerCommand('vagrantManager.halt', run('halt')),
    vscode.commands.registerCommand('vagrantManager.reload', run('reload')),
    vscode.commands.registerCommand('vagrantManager.provision', run('provision')),
    vscode.commands.registerCommand('vagrantManager.suspend', run('suspend')),
    vscode.commands.registerCommand('vagrantManager.resume', run('resume')),
    vscode.commands.registerCommand(
      'vagrantManager.destroy',
      run('destroy', { confirm: vscode.l10n.t('Destroy'), extraArgs: ['--force'] }),
    ),
    vscode.commands.registerCommand('vagrantManager.showDetails', (arg?: unknown) => {
      const t = toTarget(arg);
      if (t instanceof MachineItem) {
        DetailsPanel.show(provider, t.machine);
      }
    }),
    vscode.commands.registerCommand('vagrantManager.showTopology', (arg?: unknown) => {
      // Do menu do projeto, abre já filtrado nele; da barra da view, mostra tudo.
      const t = toTarget(arg);
      TopologyPanel.show(context, provider, t instanceof ProjectItem ? t.cwd : undefined);
    }),
    vscode.commands.registerCommand('vagrantManager.copyText', async (text?: string) => {
      if (typeof text === 'string') {
        await vscode.env.clipboard.writeText(text);
        vscode.window.setStatusBarMessage(`$(copy) ${vscode.l10n.t('Copied to clipboard')}`, 3000);
      }
    }),
    vscode.commands.registerCommand('vagrantManager.ssh', (arg?: unknown) => {
      const t = toTarget(arg);
      if (!(t instanceof MachineItem)) {
        return;
      }
      const term = vscode.window.createTerminal({
        name: `ssh: ${t.machine.name}`,
        cwd: t.machine.cwd,
        iconPath: new vscode.ThemeIcon('vm-connect'),
      });
      term.sendText(`${vagrantCmd()} ssh ${shellQuote(t.machine.name)}`);
      term.show();
    }),
    vscode.commands.registerCommand('vagrantManager.openVagrantfile', async (arg?: unknown) => {
      const t = toTarget(arg);
      if (t) {
        const cwd = t instanceof MachineItem ? t.machine.cwd : t.cwd;
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(cwd, 'Vagrantfile')));
      }
    }),
    vscode.commands.registerCommand('vagrantManager.openTerminal', (t?: ProjectItem) => {
      if (t) {
        vscode.window.createTerminal({ name: `vagrant: ${path.basename(t.cwd)}`, cwd: t.cwd }).show();
      }
    }),
  );

  // Reage a mudanças de Vagrantfile no workspace.
  const watcher = vscode.workspace.createFileSystemWatcher('**/Vagrantfile');
  watcher.onDidCreate(() => provider.refresh());
  watcher.onDidDelete(() => provider.refresh());
  watcher.onDidChange((uri) => provider.refreshProject(path.dirname(uri.fsPath)));
  context.subscriptions.push(watcher);

  // Auto-refresh configurável.
  let timer: NodeJS.Timeout | undefined;
  const setupTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    const secs = vscode.workspace.getConfiguration('vagrantManager').get<number>('autoRefreshInterval', 0);
    if (secs > 0) {
      timer = setInterval(() => {
        if (busy.size === 0) {
          provider.refresh();
        }
      }, Math.max(secs, 5) * 1000);
    }
  };
  setupTimer();
  context.subscriptions.push(
    { dispose: () => timer && clearInterval(timer) },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('vagrantManager')) {
        setupTimer();
        provider.refresh();
      }
    }),
  );
}

export function deactivate(): void {}

async function runVagrant(
  provider: MachinesProvider,
  t: Target,
  sub: string,
  opts: { confirm?: string; extraArgs?: string[] },
): Promise<void> {
  const cwd = t instanceof MachineItem ? t.machine.cwd : t.cwd;
  const label = t instanceof MachineItem ? t.machine.name : vscode.l10n.t('{0} (all)', path.basename(cwd));

  if (busy.has(cwd)) {
    vscode.window.showWarningMessage(vscode.l10n.t('A Vagrant command is already running in {0}.', path.basename(cwd)));
    return;
  }

  if (opts.confirm) {
    const pick = await vscode.window.showWarningMessage(
      `vagrant ${sub} ${label}?`,
      { modal: true, detail: vscode.l10n.t('Folder: {0}\nThis action cannot be undone.', cwd) },
      opts.confirm,
    );
    if (pick !== opts.confirm) {
      return;
    }
  }

  const args = [sub, ...(opts.extraArgs ?? [])];
  if (t instanceof MachineItem) {
    args.push(t.machine.name);
  }

  busy.add(cwd);
  output.appendLine(`\n$ (${cwd}) vagrant ${args.join(' ')}`);

  try {
    const code = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `vagrant ${sub} ${label}`,
        cancellable: true,
      },
      async (progress, token) => {
        const { child, done } = stream(args, cwd, (chunk) => {
          output.append(chunk);
          const last = chunk.trim().split('\n').pop();
          if (last) {
            progress.report({ message: last.replace(/^==>\s*/, '').slice(0, 120) });
          }
        });
        token.onCancellationRequested(() => child.kill('SIGINT'));
        return done;
      },
    );

    if (code === 0) {
      vscode.window.setStatusBarMessage(`$(check) vagrant ${sub} ${label}`, 5000);
    } else {
      const action = await vscode.window.showErrorMessage(
        vscode.l10n.t('vagrant {0} {1} failed (exit code {2}).', sub, label, String(code)),
        vscode.l10n.t('Show output'),
      );
      if (action) {
        output.show();
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    output.appendLine(vscode.l10n.t('ERROR: {0}', msg));
    vscode.window.showErrorMessage(vscode.l10n.t('Could not run vagrant: {0}', msg));
  } finally {
    busy.delete(cwd);
    provider.refreshProject(cwd);
  }
}

function vagrantCmd(): string {
  return shellQuote(vscode.workspace.getConfiguration('vagrantManager').get<string>('vagrantPath') || 'vagrant');
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
