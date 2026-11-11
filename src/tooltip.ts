import * as path from 'path';
import * as vscode from 'vscode';
import { Machine } from './vagrant';
import { MachineDetails } from './details';

/** Comandos que podem ser disparados pelos links do card. */
const ENABLED_COMMANDS = [
  'vagrantManager.ssh',
  'vagrantManager.reload',
  'vagrantManager.up',
  'vagrantManager.halt',
  'vagrantManager.openVagrantfile',
  'vagrantManager.copyText',
  'vagrantManager.showDetails',
];

export const STATE_COLOR: Record<string, string> = {
  running: '#2ea043',
  saved: '#d29922',
  paused: '#d29922',
  aborted: '#da3633',
  poweroff: '#6e7681',
  not_created: '#6e7681',
};

/** Rótulo legível do tipo de placa de rede do VirtualBox. */
export function nicLabel(type: string): string {
  switch (type) {
    case 'nat':
      return 'NAT';
    case 'intnet':
      return vscode.l10n.t('internal network');
    case 'hostonly':
      return 'host-only';
    case 'bridged':
      return 'bridge';
    case 'natnetwork':
      return 'NAT network';
    case 'generic':
      return vscode.l10n.t('generic');
    default:
      return type;
  }
}

// ---------- helpers de formatação ----------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

function code(s: string): string {
  return '`' + s.replace(/`/g, "'") + '`';
}

function muted(s: string): string {
  return `<span style="color:var(--vscode-descriptionForeground);">${s}</span>`;
}

function badge(text: string, bg: string): string {
  return `<span style="color:#ffffff;background-color:${bg};border-radius:4px;">&nbsp;${esc(text)}&nbsp;</span>`;
}

function section(icon: string, title: string): string {
  return `$(${icon}) ${muted(`**${title.toUpperCase()}**`)}`;
}

function link(icon: string, label: string, command: string, args: unknown[]): string {
  return `[$(${icon}) ${label}](command:${command}?${encodeURIComponent(JSON.stringify(args))} "${label}")`;
}

export function tildify(p: string): string {
  const home = process.env.HOME;
  return home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

/** Caminho relativo ao projeto quando estiver dentro dele (./sub), senão com ~. */
export function relToProject(p: string, cwd: string): string {
  const rel = path.relative(cwd, p);
  if (!rel) return './';
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return `./${rel}`;
  return tildify(p);
}

/**
 * O VirtualBox grava VMStateChangeTime em UTC, sem fuso e com nanossegundos
 * (ex.: 2026-11-11T22:30:38.269000000). Normaliza para ISO com Z.
 */
export function parseVBoxTime(s: string): number {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(s.trim());
  if (!m) return Date.parse(s);
  const ms = (m[2] ?? '0').padEnd(3, '0').slice(0, 3);
  return Date.parse(`${m[1]}.${ms}${m[3] ?? 'Z'}`);
}

export function uptime(since: string): string | undefined {
  const t = parseVBoxTime(since);
  if (Number.isNaN(t)) return undefined;
  const min = Math.max(0, Math.floor((Date.now() - t) / 60_000));
  if (min < 1) return vscode.l10n.t('less than 1 min');
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${min % 60}min`;
  const days = Math.floor(h / 24);
  return days > 1 ? vscode.l10n.t('{0} days {1}h', days, h % 24) : vscode.l10n.t('1 day {0}h', h % 24);
}

export function formatMemory(mb: number): string {
  return mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`;
}

// ---------- card ----------

/** Monta o card (tooltip) da VM. */
export function renderTooltip(m: Machine, d: MachineDetails | undefined): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.supportHtml = true;
  md.isTrusted = { enabledCommands: ENABLED_COMMANDS };

  const blocks: string[] = [];
  const running = m.state === 'running';

  // Cabeçalho: nome + estado + provider, e na linha de baixo box e uptime.
  const header = [
    `$(${running ? 'vm-running' : 'vm'}) **${esc(m.name)}** &nbsp; ${badge(m.stateLabel, STATE_COLOR[m.state] ?? '#6e7681')} &nbsp; ${muted(esc(m.provider || ''))}`,
  ];
  const sub: string[] = [];
  if (d?.box) sub.push(`$(package) ${code(d.box.name)}${d.box.version ? ' ' + muted(esc(d.box.version)) : ''}`);
  const up = running && d?.vbox?.stateSince ? uptime(d.vbox.stateSince) : undefined;
  if (up) sub.push(`$(clock) ${esc(vscode.l10n.t('up for {0}', up))}`);
  if (sub.length) header.push(sub.join(' &nbsp;·&nbsp; '));
  blocks.push(header.join('  \n'));

  if (!d) {
    blocks.push(`$(loading~spin) ${vscode.l10n.t('Loading details…')}`);
    return finish(md, blocks);
  }

  // Recursos
  const v = d.vbox;
  if (v && (v.cpus !== undefined || v.memoryMb !== undefined || v.osType)) {
    const res: string[] = [];
    if (v.cpus !== undefined) res.push(`$(circuit-board) **${v.cpus}** vCPU`);
    if (v.memoryMb !== undefined) res.push(`$(server) **${esc(formatMemory(v.memoryMb))}** RAM`);
    if (v.osType) res.push(`$(device-desktop) ${esc(v.osType)}`);
    blocks.push(`${section('dashboard', vscode.l10n.t('Resources'))}  \n${res.join(' &nbsp;&nbsp; ')}`);
  }

  // Rede e acesso em formato resumido (a lista completa fica no painel de detalhes).
  const net: string[] = [];
  if (v?.nics.length) {
    const names = v.nics.filter((n) => n.type !== 'nat' && n.network).map((n) => code(n.network!));
    const ips = v.nics.filter((n) => n.ip).map((n) => code(n.ip!));
    net.push(
      `$(type-hierarchy-sub) ${muted(vscode.l10n.t('Network'))} &nbsp; **${v.nics.length}** ${v.nics.length > 1 ? vscode.l10n.t('adapters') : vscode.l10n.t('adapter')}` +
        (names.length ? ` · ${names.join(' ')}` : ''),
    );
    if (ips.length) net.push(`$(globe) ${muted('IPs')} &nbsp; ${ips.join(' ')}`);
  }
  const ssh = sshCommand(d);
  if (ssh) {
    net.push(`$(terminal) ${muted('SSH')} &nbsp; ${code(ssh.target)}`);
  }
  if (net.length) {
    blocks.push(net.join('  \n'));
  }

  // Erros
  if (d.errors.length) {
    blocks.push(d.errors.map((e) => `$(warning) ${muted(esc(e))}`).join('  \n'));
  }

  // Ações
  const actions: string[] = [link('info', vscode.l10n.t('Details'), 'vagrantManager.showDetails', [m])];
  if (running) {
    actions.push(link('terminal', 'SSH', 'vagrantManager.ssh', [m]));
    if (ssh) actions.push(link('copy', vscode.l10n.t('Copy SSH'), 'vagrantManager.copyText', [ssh.command]));
    actions.push(link('debug-restart', 'Reload', 'vagrantManager.reload', [m]));
    actions.push(link('debug-stop', 'Halt', 'vagrantManager.halt', [m]));
  } else {
    actions.push(link('play', 'Up', 'vagrantManager.up', [m]));
  }
  blocks.push(actions.join(' &nbsp;·&nbsp; '));

  // Rodapé técnico
  const meta: string[] = [];
  if (v?.vmName) meta.push(esc(v.vmName));
  if (d.id) meta.push(esc(d.id.slice(0, 8)));
  blocks.push(`<small>${muted(meta.join(' · '))}</small>`);

  return finish(md, blocks);
}

/** Alvo (user@host:porta) e comando ssh completo, quando há ssh-config. */
export function sshCommand(d: MachineDetails): { target: string; command: string } | undefined {
  if (!d.ssh || !(d.ssh.host || d.ssh.port)) return undefined;
  const user = d.ssh.user ?? 'vagrant';
  const host = d.ssh.host ?? '127.0.0.1';
  const port = d.ssh.port ?? '22';
  return {
    target: `${user}@${host}:${port}`,
    command: `ssh -p ${port}${d.ssh.identityFile ? ` -i '${d.ssh.identityFile}'` : ''} ${user}@${host}`,
  };
}

function finish(md: vscode.MarkdownString, blocks: string[]): vscode.MarkdownString {
  // Linha em branco antes de cada "---" para não virar título setext.
  md.appendMarkdown(blocks.join('\n\n---\n\n'));
  return md;
}
