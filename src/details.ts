import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { Machine, exec, runProcess } from './vagrant';

export interface BoxMeta {
  name: string;
  version?: string;
}

export interface SyncedFolder {
  type: string;
  hostpath: string;
  guestpath: string;
}

export interface Nic {
  index: number;
  type: string;
  network?: string;
  mac?: string;
  connected: boolean;
  ip?: string;
}

export interface PortForward {
  name: string;
  protocol: string;
  hostIp: string;
  hostPort: string;
  guestPort: string;
}

export interface VBoxInfo {
  vmName: string;
  osType?: string;
  memoryMb?: number;
  cpus?: number;
  vramMb?: number;
  stateSince?: string;
  nics: Nic[];
  forwards: PortForward[];
}

export interface SshConfig {
  host?: string;
  port?: string;
  user?: string;
  identityFile?: string;
}

export interface MachineDetails {
  id?: string;
  box?: BoxMeta;
  syncedFolders: SyncedFolder[];
  vbox?: VBoxInfo;
  ssh?: SshConfig;
  errors: string[];
}

function cfg<T>(key: string, def: T): T {
  return vscode.workspace.getConfiguration('vagrantManager').get<T>(key, def);
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return (await fs.readFile(file, 'utf8')).trim();
  } catch {
    return undefined;
  }
}

async function readJson<T>(file: string): Promise<T | undefined> {
  const txt = await readText(file);
  if (!txt) {
    return undefined;
  }
  try {
    return JSON.parse(txt) as T;
  } catch {
    return undefined;
  }
}

/** Lê os metadados que o Vagrant grava em .vagrant/machines/<vm>/<provider>/. */
async function readLocalMeta(m: Machine, d: MachineDetails): Promise<void> {
  const dir = path.join(m.cwd, '.vagrant', 'machines', m.name, m.provider || 'virtualbox');
  const [id, box, synced] = await Promise.all([
    readText(path.join(dir, 'id')),
    readJson<BoxMeta>(path.join(dir, 'box_meta')),
    readJson<Record<string, Record<string, SyncedFolder & { disabled?: boolean }>>>(path.join(dir, 'synced_folders')),
  ]);
  d.id = id || undefined;
  d.box = box;
  if (synced) {
    for (const [type, folders] of Object.entries(synced)) {
      for (const f of Object.values(folders)) {
        if (!f.disabled) {
          d.syncedFolders.push({ type, hostpath: f.hostpath, guestpath: f.guestpath });
        }
      }
    }
  }
}

/** Interpreta `VBoxManage showvminfo --machinereadable` (linhas chave=valor). */
export function parseShowVmInfo(output: string): VBoxInfo {
  const kv = new Map<string, string>();
  const forwards: PortForward[] = [];
  for (const line of output.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i < 0) {
      continue;
    }
    const key = line.slice(0, i).replace(/^"|"$/g, '');
    const value = line.slice(i + 1).replace(/^"|"$/g, '');
    if (key.startsWith('Forwarding(')) {
      // name,proto,hostip,hostport,guestip,guestport
      const [name, protocol, hostIp, hostPort, , guestPort] = value.split(',');
      forwards.push({ name, protocol, hostIp: hostIp || '0.0.0.0', hostPort, guestPort });
    } else {
      kv.set(key, value);
    }
  }

  const nics: Nic[] = [];
  for (let n = 1; n <= 36; n++) {
    const type = kv.get(`nic${n}`);
    if (type === undefined) {
      break;
    }
    if (type === 'none') {
      continue;
    }
    const network =
      kv.get(`intnet${n}`) ??
      kv.get(`hostonlyadapter${n}`) ??
      kv.get(`bridgeadapter${n}`) ??
      kv.get(`natnetwork${n}`) ??
      (type === 'nat' ? 'NAT' : undefined);
    const mac = kv.get(`macaddress${n}`);
    nics.push({
      index: n,
      type,
      network,
      mac: mac ? mac.match(/../g)?.join(':') : undefined,
      connected: kv.get(`cableconnected${n}`) !== 'off',
    });
  }

  const num = (k: string) => {
    const v = kv.get(k);
    return v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined;
  };

  return {
    vmName: kv.get('name') ?? '',
    osType: kv.get('ostype'),
    memoryMb: num('memory'),
    cpus: num('cpus'),
    vramMb: num('vram'),
    stateSince: kv.get('VMStateChangeTime'),
    nics,
    forwards,
  };
}

/** IPs reportados pelas Guest Additions (se instaladas), indexados pela ordem da placa. */
async function guestIps(vbox: string, id: string): Promise<Map<string, string>> {
  const ips = new Map<string, string>(); // mac -> ip
  const res = await runProcess(vbox, ['guestproperty', 'enumerate', id, '--patterns', '/VirtualBox/GuestInfo/Net/*'], undefined, 10_000);
  if (res.code !== 0) {
    return ips;
  }
  const byIdx = new Map<string, { ip?: string; mac?: string }>();
  // Formatos: "Name: /VirtualBox/GuestInfo/Net/0/V4/IP, value: 10.0.2.15, ..." (6.x)
  //           "/VirtualBox/GuestInfo/Net/0/V4/IP = '10.0.2.15' @ ..."       (7.x)
  const re = /\/VirtualBox\/GuestInfo\/Net\/(\d+)\/(V4\/IP|MAC)(?:,\s*value:\s*|\s*=\s*')([^,'\s]+)/;
  for (const line of res.stdout.split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m) {
      continue;
    }
    const e = byIdx.get(m[1]) ?? {};
    if (m[2] === 'MAC') {
      e.mac = m[3].toUpperCase();
    } else {
      e.ip = m[3];
    }
    byIdx.set(m[1], e);
  }
  for (const e of byIdx.values()) {
    if (e.mac && e.ip) {
      ips.set(e.mac, e.ip);
    }
  }
  return ips;
}

async function readVBox(id: string, d: MachineDetails): Promise<void> {
  const vbox = cfg('vboxManagePath', 'VBoxManage');
  const res = await runProcess(vbox, ['showvminfo', id, '--machinereadable'], undefined, 15_000);
  if (res.code !== 0) {
    d.errors.push(`VBoxManage: ${res.stderr.trim().split('\n')[0] || `código ${res.code}`}`);
    return;
  }
  const info = parseShowVmInfo(res.stdout);
  try {
    const ips = await guestIps(vbox, id);
    for (const nic of info.nics) {
      const raw = nic.mac?.replace(/:/g, '');
      if (raw && ips.has(raw)) {
        nic.ip = ips.get(raw);
      }
    }
  } catch {
    // Guest Additions ausentes: segue sem IPs.
  }
  d.vbox = info;
}

async function readSshConfig(m: Machine, d: MachineDetails): Promise<void> {
  const res = await exec(['ssh-config', m.name], m.cwd, 30_000);
  if (res.code !== 0) {
    d.errors.push(`ssh-config: ${res.stderr.trim().split('\n')[0] || `código ${res.code}`}`);
    return;
  }
  const ssh: SshConfig = {};
  for (const line of res.stdout.split(/\r?\n/)) {
    const [key, ...rest] = line.trim().split(/\s+/);
    const value = rest.join(' ').replace(/^"|"$/g, '');
    switch (key) {
      case 'HostName':
        ssh.host = value;
        break;
      case 'Port':
        ssh.port = value;
        break;
      case 'User':
        ssh.user = value;
        break;
      case 'IdentityFile':
        ssh.identityFile ??= value;
        break;
    }
  }
  d.ssh = ssh;
}

export async function loadDetails(m: Machine): Promise<MachineDetails> {
  const d: MachineDetails = { syncedFolders: [], errors: [] };
  await readLocalMeta(m, d);

  const tasks: Promise<void>[] = [];
  if (d.id && (m.provider === 'virtualbox' || !m.provider) && m.state !== 'not_created') {
    tasks.push(readVBox(d.id, d).catch((e) => void d.errors.push(`VBoxManage: ${errMsg(e)}`)));
  }
  if (m.state === 'running') {
    tasks.push(readSshConfig(m, d).catch((e) => void d.errors.push(`ssh-config: ${errMsg(e)}`)));
  }
  await Promise.all(tasks);
  return d;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
