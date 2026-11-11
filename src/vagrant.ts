import { spawn, ChildProcess } from 'child_process';
import * as vscode from 'vscode';

export type MachineState =
  | 'running'
  | 'poweroff'
  | 'saved'
  | 'not_created'
  | 'aborted'
  | 'paused'
  | string;

export interface Machine {
  name: string;
  state: MachineState;
  stateLabel: string;
  provider: string;
  /** Pasta que contém o Vagrantfile. */
  cwd: string;
}

export interface GlobalEntry {
  id: string;
  provider: string;
  home: string;
  state: MachineState;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function vagrantPath(): string {
  return vscode.workspace.getConfiguration('vagrantManager').get<string>('vagrantPath') || 'vagrant';
}

/** Executa o vagrant e devolve a saída completa (para comandos de leitura). */
export function exec(args: string[], cwd?: string, timeoutMs = 60_000): Promise<RunResult> {
  return runProcess(vagrantPath(), args, cwd, timeoutMs);
}

/** Executa qualquer binário e devolve a saída completa. */
export function runProcess(cmd: string, args: string[], cwd?: string, timeoutMs = 60_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Executa o vagrant transmitindo a saída para um callback (para comandos longos). */
export function stream(
  args: string[],
  cwd: string,
  onData: (chunk: string) => void,
): { child: ChildProcess; done: Promise<number | null> } {
  const child = spawn(vagrantPath(), args, { cwd, env: { ...process.env, VAGRANT_NO_COLOR: '1' } });
  child.stdout?.on('data', (d) => onData(d.toString()));
  child.stderr?.on('data', (d) => onData(d.toString()));
  const done = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { child, done };
}

interface MrLine {
  target: string;
  type: string;
  data: string[];
}

/** Interpreta o formato `--machine-readable`: timestamp,target,type,data... */
export function parseMachineReadable(output: string): MrLine[] {
  const lines: MrLine[] = [];
  for (const raw of output.split(/\r?\n/)) {
    if (!raw.trim()) {
      continue;
    }
    const parts = raw.split(',');
    if (parts.length < 3) {
      continue;
    }
    lines.push({
      target: parts[1],
      type: parts[2],
      data: parts.slice(3).map((p) => p.replace(/%!\(VAGRANT_COMMA\)/g, ',').replace(/\\n/g, '\n')),
    });
  }
  return lines;
}

/** `vagrant status` em uma pasta com Vagrantfile. */
export async function status(cwd: string): Promise<Machine[]> {
  const res = await exec(['status', '--machine-readable'], cwd);
  if (res.code !== 0) {
    const err = parseMachineReadable(res.stdout).find((l) => l.type === 'error-exit');
    throw new Error(err?.data[1] || res.stderr.trim() || vscode.l10n.t('vagrant status exited with code {0}', String(res.code)));
  }
  const byName = new Map<string, Machine>();
  const get = (name: string) => {
    let m = byName.get(name);
    if (!m) {
      m = { name, state: 'unknown', stateLabel: 'unknown', provider: '', cwd };
      byName.set(name, m);
    }
    return m;
  };
  for (const l of parseMachineReadable(res.stdout)) {
    if (!l.target) {
      continue;
    }
    switch (l.type) {
      case 'state':
        get(l.target).state = l.data[0];
        break;
      case 'state-human-short':
        get(l.target).stateLabel = l.data[0];
        break;
      case 'provider-name':
        get(l.target).provider = l.data[0];
        break;
    }
  }
  return [...byName.values()];
}

/** `vagrant global-status`: só traz id, provider, pasta e estado (sem o nome). */
export async function globalStatus(prune: boolean): Promise<GlobalEntry[]> {
  const args = ['global-status', '--machine-readable'];
  if (prune) {
    args.push('--prune');
  }
  const res = await exec(args, undefined, prune ? 180_000 : 60_000);
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || vscode.l10n.t('vagrant global-status exited with code {0}', String(res.code)));
  }
  const entries: GlobalEntry[] = [];
  let cur: Partial<GlobalEntry> | undefined;
  for (const l of parseMachineReadable(res.stdout)) {
    switch (l.type) {
      case 'machine-id':
        cur = { id: l.data[0] };
        entries.push(cur as GlobalEntry);
        break;
      case 'provider-name':
        if (cur) cur.provider = l.data[0];
        break;
      case 'machine-home':
        if (cur) cur.home = l.data[0];
        break;
      case 'state':
        if (cur) cur.state = l.data[0];
        break;
    }
  }
  return entries.filter((e) => e.home);
}
