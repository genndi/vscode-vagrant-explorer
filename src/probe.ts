import * as fs from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Machine, exec, runProcess } from './vagrant';
import { SshConfig } from './details';

/**
 * Teste de conectividade: a partir de uma origem (uma VM ou o host), testa
 * cada IP com ping (ICMP) ou com uma conexão TCP numa porta.
 *
 * Numa VM, tudo roda numa única sessão `ssh -F <ssh-config do Vagrant>`, com
 * os testes em paralelo. O `ssh -F` respeita todas as opções que o Vagrant
 * escolheu (chave, porta, algoritmos legados de boxes antigas). Sem o binário
 * `ssh`, usa `vagrant ssh -c`, que é mais lento.
 */

export type ProbeStatus = 'ok' | 'fail' | 'notool';

export interface ProbeResult {
  status: ProbeStatus;
  /** Tempo de resposta do ping em ms, quando disponível. */
  rttMs?: number;
}

export interface ProbeOutcome {
  results: Record<string, ProbeResult>;
  /** Erro que impediu o teste inteiro (ex.: SSH falhou). */
  error?: string;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** Só IPv4 válidos e porta 1-65535: os valores entram num comando de shell. */
export function sanitizeTargets(ips: unknown, port: unknown): { ips: string[]; port?: number } {
  const list = Array.isArray(ips) ? [...new Set(ips.filter((ip): ip is string => typeof ip === 'string' && IPV4.test(ip)))] : [];
  const p = Number(port);
  return { ips: list.slice(0, 64), port: Number.isInteger(p) && p >= 1 && p <= 65535 ? p : undefined };
}

/** Script POSIX que roda dentro da VM e imprime uma linha `VMTEST <ip> <status> [rtt]` por alvo. */
export function buildProbeScript(ips: string[], port?: number): string {
  const safe = sanitizeTargets(ips, port);
  const targets = safe.ips.map((ip) => `p ${ip} &`).join(' ');
  if (safe.port === undefined) {
    return [
      'command -v ping >/dev/null 2>&1 || { echo VMTEST_NOTOOL; exit 0; }',
      'p() { if o=$(ping -c 1 -W 2 "$1" 2>&1); then r=$(printf "%s\\n" "$o" | sed -n "s/.*time[=<] *\\([0-9.]*\\).*/\\1/p" | head -n 1); echo "VMTEST $1 ok $r"; else echo "VMTEST $1 fail"; fi; }',
      `${targets} wait`,
    ].join('\n');
  }
  // bash /dev/tcp primeiro (o ncat do CentOS 7 não tem -z); depois nc -z (busybox/Alpine).
  return [
    `t() { if command -v bash >/dev/null 2>&1; then timeout 2 bash -c "</dev/tcp/$1/${safe.port}" >/dev/null 2>&1; elif command -v nc >/dev/null 2>&1; then nc -z -w 2 "$1" ${safe.port} >/dev/null 2>&1; else return 99; fi; }`,
    'p() { t "$1"; rc=$?; if [ $rc = 0 ]; then echo "VMTEST $1 ok"; elif [ $rc = 99 ]; then echo "VMTEST $1 notool"; else echo "VMTEST $1 fail"; fi; }',
    `${targets} wait`,
  ].join('\n');
}

/** Interpreta a saída do script. */
export function parseProbeOutput(output: string, ips: string[]): ProbeOutcome {
  const results: Record<string, ProbeResult> = {};
  if (/^VMTEST_NOTOOL$/m.test(output)) {
    for (const ip of ips) results[ip] = { status: 'notool' };
    return { results };
  }
  for (const line of output.split(/\r?\n/)) {
    const m = /^VMTEST (\S+) (ok|fail|notool)(?: ([\d.]+))?\s*$/.exec(line.trim());
    if (!m || !ips.includes(m[1])) continue;
    results[m[1]] = { status: m[2] as ProbeStatus, rttMs: m[3] ? Number(m[3]) : undefined };
  }
  return { results };
}

/** Testa a partir de uma VM ligada. */
export async function probeFromVm(m: Machine, ssh: SshConfig | undefined, ips: string[], port?: number): Promise<ProbeOutcome> {
  const script = buildProbeScript(ips, port);
  let res;
  if (ssh?.raw && ssh.alias) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vagrant-explorer-ssh-'));
    const cfg = path.join(dir, 'config');
    try {
      await fs.writeFile(cfg, ssh.raw, { mode: 0o600 });
      res = await runProcess('ssh', ['-F', cfg, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', ssh.alias, script], undefined, 30_000);
    } catch (e) {
      // Sem o binário ssh: cai para o vagrant.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      res = undefined;
    } finally {
      void fs.rm(dir, { recursive: true, force: true });
    }
  }
  res ??= await exec(['ssh', m.name, '-c', script], m.cwd, 60_000);
  const out = parseProbeOutput(res.stdout, ips);
  if (res.code === 255 || (Object.keys(out.results).length === 0 && res.code !== 0)) {
    const msg = res.stderr.trim().split('\n').filter(Boolean).pop();
    return {
      results: {},
      error: msg
        ? vscode.l10n.t('Could not connect via SSH: {0}', msg)
        : vscode.l10n.t('Could not connect via SSH (exit code {0}).', String(res.code)),
    };
  }
  return out;
}

/** Argumentos do ping de um pacote com tempo limite de 2 s, por sistema. */
export function hostPingArgs(ip: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') return ['-n', '1', '-w', '2000', ip];
  if (platform === 'darwin') return ['-c', '1', '-t', '2', ip];
  return ['-c', '1', '-W', '2', ip];
}

/** Tempo de resposta na saída do ping (Linux, macOS e Windows em inglês). */
export function parsePingRtt(output: string): number | undefined {
  const m = /time[=<]\s*([\d.]+)\s*ms/i.exec(output);
  return m ? Number(m[1]) : undefined;
}

/** Testa a partir do próprio host. */
export async function probeFromHost(ips: string[], port?: number): Promise<ProbeOutcome> {
  const safe = sanitizeTargets(ips, port);
  const results: Record<string, ProbeResult> = {};
  await Promise.all(
    safe.ips.map(async (ip) => {
      if (safe.port !== undefined) {
        results[ip] = { status: (await tcpConnect(ip, safe.port, 2000)) ? 'ok' : 'fail' };
        return;
      }
      try {
        const res = await runProcess('ping', hostPingArgs(ip), undefined, 5000);
        // No Windows o ping pode sair com 0 em "host inacessível": exige o tempo de resposta.
        const rtt = parsePingRtt(res.stdout);
        const ok = res.code === 0 && (process.platform !== 'win32' || rtt !== undefined || /TTL=/i.test(res.stdout));
        results[ip] = { status: ok ? 'ok' : 'fail', rttMs: ok ? rtt : undefined };
      } catch {
        results[ip] = { status: 'notool' };
      }
    }),
  );
  return { results };
}

function tcpConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
