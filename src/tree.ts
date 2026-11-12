import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { Machine, GlobalEntry, status, globalStatus } from './vagrant';
import { MachineDetails, loadDetails } from './details';
import { renderTooltip } from './tooltip';

export class ProjectItem extends vscode.TreeItem {
  readonly kind = 'project' as const;

  constructor(
    readonly cwd: string,
    readonly inWorkspace: boolean,
  ) {
    super(path.basename(cwd), vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `project:${cwd}`;
    this.contextValue = 'project';
    this.description = tildify(path.dirname(cwd));
    this.tooltip = cwd;
    this.iconPath = new vscode.ThemeIcon(inWorkspace ? 'folder-active' : 'folder');
    this.resourceUri = vscode.Uri.file(cwd);
  }
}

export class MachineItem extends vscode.TreeItem {
  readonly kind = 'machine' as const;

  constructor(readonly machine: Machine) {
    super(machine.name, vscode.TreeItemCollapsibleState.None);
    this.id = `machine:${machine.cwd}:${machine.name}`;
    this.contextValue = `machine.${machine.state}`;
    this.description = machine.provider ? `${machine.stateLabel} · ${machine.provider}` : machine.stateLabel;
    // Tooltip fica indefinido de propósito: é preenchido sob demanda em resolveTreeItem.
    this.iconPath = stateIcon(machine.state);
    this.command = { command: 'vagrantManager.showDetails', title: vscode.l10n.t('Details'), arguments: [machine] };
  }
}

class MessageItem extends vscode.TreeItem {
  readonly kind = 'message' as const;
  constructor(label: string, icon: string, tooltip?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.tooltip = tooltip;
  }
}

export type Node = ProjectItem | MachineItem | MessageItem;

function stateIcon(state: string): vscode.ThemeIcon {
  switch (state) {
    case 'running':
      return new vscode.ThemeIcon('vm-running', new vscode.ThemeColor('testing.iconPassed'));
    case 'saved':
    case 'paused':
      return new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('editorWarning.foreground'));
    case 'aborted':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    case 'not_created':
      return new vscode.ThemeIcon('circle-outline');
    default:
      return new vscode.ThemeIcon('vm-outline');
  }
}

function tildify(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

export class MachinesProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private statusCache = new Map<string, Promise<Machine[]>>();
  private globalCache?: Promise<GlobalEntry[]>;

  /** Último global-status conhecido, para a status bar. */
  lastGlobal: GlobalEntry[] = [];
  private readonly globalEmitter = new vscode.EventEmitter<GlobalEntry[]>();
  readonly onDidLoadGlobal = this.globalEmitter.event;

  private detailsCache = new Map<string, Promise<MachineDetails>>();
  /** Detalhes sem ssh-config (só rede/recursos), usados pela topologia. */
  private netCache = new Map<string, Promise<MachineDetails>>();

  refresh(): void {
    this.statusCache.clear();
    this.detailsCache.clear();
    this.netCache.clear();
    this.globalCache = undefined;
    this.emitter.fire();
  }

  /** Atualiza só um projeto (após rodar um comando nele). */
  refreshProject(cwd: string): void {
    this.statusCache.delete(cwd);
    for (const cache of [this.detailsCache, this.netCache]) {
      for (const key of cache.keys()) {
        if (key.startsWith(`machine:${cwd}:`)) {
          cache.delete(key);
        }
      }
    }
    this.globalCache = undefined;
    this.emitter.fire();
  }

  getTreeItem(el: Node): vscode.TreeItem {
    return el;
  }

  /** Chamado no hover: carrega os detalhes da VM e monta o tooltip. */
  async resolveTreeItem(item: vscode.TreeItem, el: Node, token: vscode.CancellationToken): Promise<vscode.TreeItem> {
    if (!(el instanceof MachineItem) || !el.id) {
      return item;
    }
    try {
      const details = await this.getDetails(el.machine);
      if (!token.isCancellationRequested) {
        item.tooltip = renderTooltip(el.machine, details);
      }
    } catch (err) {
      const d: MachineDetails = { syncedFolders: [], errors: [err instanceof Error ? err.message : String(err)] };
      item.tooltip = renderTooltip(el.machine, d);
    }
    return item;
  }

  async getChildren(el?: Node): Promise<Node[]> {
    if (!el) {
      return this.getProjects();
    }
    if (el instanceof ProjectItem) {
      try {
        const machines = await this.getStatus(el.cwd);
        if (machines.length === 0) {
          return [new MessageItem(vscode.l10n.t('No VMs defined'), 'info')];
        }
        return machines.map((m) => new MachineItem(m));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return [new MessageItem(msg.split('\n')[0], 'warning', msg)];
      }
    }
    return [];
  }

  /** Detalhes da VM, com cache até o próximo refresh. */
  getDetails(m: Machine): Promise<MachineDetails> {
    const key = `machine:${m.cwd}:${m.name}`;
    let p = this.detailsCache.get(key);
    if (!p) {
      p = loadDetails(m);
      this.detailsCache.set(key, p);
      p.catch(() => this.detailsCache.delete(key));
    }
    return p;
  }

  /** Detalhes de rede da VM: reaproveita os detalhes completos se já carregados. */
  getNetDetails(m: Machine): Promise<MachineDetails> {
    const key = `machine:${m.cwd}:${m.name}`;
    const full = this.detailsCache.get(key);
    if (full) {
      return full;
    }
    let p = this.netCache.get(key);
    if (!p) {
      p = loadDetails(m, { ssh: false });
      this.netCache.set(key, p);
      p.catch(() => this.netCache.delete(key));
    }
    return p;
  }

  /** Estado atual de uma VM específica (usa o cache de status do projeto). */
  async getMachine(cwd: string, name: string): Promise<Machine | undefined> {
    return (await this.getStatus(cwd)).find((m) => m.name === name);
  }

  /** Pastas de projeto conhecidas (workspace + global-status), na ordem da árvore. */
  async listProjects(): Promise<string[]> {
    const nodes = await this.getProjects();
    return nodes.filter((n): n is ProjectItem => n instanceof ProjectItem).map((p) => p.cwd);
  }

  /** VMs de um projeto (usa o mesmo cache da árvore). */
  getMachines(cwd: string): Promise<Machine[]> {
    return this.getStatus(cwd);
  }

  private getStatus(cwd: string): Promise<Machine[]> {
    let p = this.statusCache.get(cwd);
    if (!p) {
      p = status(cwd);
      this.statusCache.set(cwd, p);
      p.catch(() => this.statusCache.delete(cwd));
    }
    return p;
  }

  private loadGlobal(): Promise<GlobalEntry[]> {
    if (!this.globalCache) {
      const prune = vscode.workspace.getConfiguration('vagrantManager').get<boolean>('pruneGlobalStatus', false);
      this.globalCache = globalStatus(prune).then(
        (entries) => {
          this.lastGlobal = entries;
          this.globalEmitter.fire(entries);
          return entries;
        },
        (err) => {
          this.globalCache = undefined;
          throw err;
        },
      );
    }
    return this.globalCache;
  }

  private async getProjects(): Promise<Node[]> {
    const cfg = vscode.workspace.getConfiguration('vagrantManager');
    const showGlobal = cfg.get<boolean>('showGlobalMachines', true);

    // O global-status é sempre carregado porque alimenta a status bar.
    const [files, global] = await Promise.all([
      vscode.workspace.findFiles('**/Vagrantfile', '**/{node_modules,.git,.vagrant}/**', 200),
      this.loadGlobal().catch((err): Error => (err instanceof Error ? err : new Error(String(err)))),
    ]);

    const workspaceDirs = new Set(files.map((f) => path.dirname(f.fsPath)));
    const projects = new Map<string, ProjectItem>();

    for (const dir of workspaceDirs) {
      projects.set(dir, new ProjectItem(dir, true));
    }

    const items: Node[] = [];
    if (global instanceof Error) {
      items.push(new MessageItem(vscode.l10n.t('global-status failed: {0}', global.message.split('\n')[0]), 'warning', global.message));
    } else if (showGlobal) {
      for (const e of global) {
        if (!projects.has(e.home) && fs.existsSync(path.join(e.home, 'Vagrantfile'))) {
          projects.set(e.home, new ProjectItem(e.home, false));
        }
      }
    }

    const sorted = [...projects.values()].sort((a, b) => {
      if (a.inWorkspace !== b.inWorkspace) {
        return a.inWorkspace ? -1 : 1;
      }
      return a.cwd.localeCompare(b.cwd);
    });

    // Expande automaticamente quando há um único projeto.
    if (sorted.length === 1) {
      sorted[0].collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    }

    return [...items, ...sorted];
  }
}
