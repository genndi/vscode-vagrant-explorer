import './vscodeStub';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { formatMemory, nicLabel, parseVBoxTime, relToProject, renderTooltip, sshCommand, uptime } from '../tooltip';
import { MachineDetails } from '../details';
import { Machine } from '../vagrant';

test('parseVBoxTime trata horário sem fuso como UTC e corta nanossegundos', () => {
  assert.equal(parseVBoxTime('2026-11-11T22:30:38.269000000'), Date.UTC(2026, 10, 11, 22, 30, 38, 269));
  assert.equal(parseVBoxTime('2026-11-11T22:30:38'), Date.UTC(2026, 10, 11, 22, 30, 38));
});

test('parseVBoxTime respeita fuso explícito', () => {
  assert.equal(parseVBoxTime('2026-11-11T22:30:38.5Z'), Date.UTC(2026, 10, 11, 22, 30, 38, 500));
  assert.equal(parseVBoxTime('2026-11-11T19:30:38-03:00'), Date.UTC(2026, 10, 11, 22, 30, 38));
});

test('uptime formata minutos, horas e dias', () => {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  assert.equal(uptime(ago(0)), 'less than 1 min');
  assert.equal(uptime(ago(5)), '5 min');
  assert.equal(uptime(ago(90)), '1h 30min');
  assert.equal(uptime(ago(26 * 60)), '1 day 2h');
  assert.equal(uptime(ago(3 * 24 * 60 + 60)), '3 days 1h');
  assert.equal(uptime('não é data'), undefined);
});

test('formatMemory usa GB só para múltiplos exatos de 1024', () => {
  assert.equal(formatMemory(2048), '2 GB');
  assert.equal(formatMemory(1536), '1536 MB');
  assert.equal(formatMemory(512), '512 MB');
});

test('relToProject mostra caminho relativo dentro do projeto', () => {
  assert.equal(relToProject('/p/lab', '/p/lab'), './');
  assert.equal(relToProject('/p/lab/.vagrant/key', '/p/lab'), './.vagrant/key');
  assert.equal(relToProject('/outro/lugar', '/p/lab'), '/outro/lugar');
});

test('sshCommand monta alvo e comando, com padrões', () => {
  const d: MachineDetails = { syncedFolders: [], errors: [], ssh: { host: '127.0.0.1', port: '2222', user: 'vagrant', identityFile: '/k/id' } };
  assert.deepEqual(sshCommand(d), { target: 'vagrant@127.0.0.1:2222', command: "ssh -p 2222 -i '/k/id' vagrant@127.0.0.1" });
  assert.deepEqual(sshCommand({ syncedFolders: [], errors: [], ssh: { port: '2200' } }), {
    target: 'vagrant@127.0.0.1:2200',
    command: 'ssh -p 2200 vagrant@127.0.0.1',
  });
  assert.equal(sshCommand({ syncedFolders: [], errors: [] }), undefined);
  assert.equal(sshCommand({ syncedFolders: [], errors: [], ssh: {} }), undefined);
});

test('nicLabel traduz os tipos do VirtualBox', () => {
  assert.equal(nicLabel('nat'), 'NAT');
  assert.equal(nicLabel('intnet'), 'internal network');
  assert.equal(nicLabel('hostonly'), 'host-only');
  assert.equal(nicLabel('xyz'), 'xyz');
});

test('renderTooltip mostra estado, recursos, rede e links de ação', () => {
  const m: Machine = { name: 'web', state: 'running', stateLabel: 'running', provider: 'virtualbox', cwd: '/p/lab' };
  const d: MachineDetails = {
    syncedFolders: [],
    errors: [],
    box: { name: 'ubuntu/jammy64' },
    ssh: { host: '127.0.0.1', port: '2222' },
    vbox: {
      vmName: 'lab_web',
      cpus: 2,
      memoryMb: 2048,
      forwards: [],
      nics: [
        { index: 1, type: 'nat', network: 'NAT', connected: true },
        { index: 2, type: 'hostonly', network: 'vboxnet0', connected: true, ip: '192.168.56.10' },
      ],
    },
  };
  const md = renderTooltip(m, d).value;
  assert.match(md, /\*\*web\*\*/);
  assert.match(md, /\*\*2\*\* vCPU/);
  assert.match(md, /\*\*2 GB\*\* RAM/);
  assert.match(md, /`vboxnet0`/);
  assert.match(md, /`192\.168\.56\.10`/);
  assert.match(md, /command:vagrantManager\.halt\?/);
  assert.doesNotMatch(md, /command:vagrantManager\.up\?/);
});

test('renderTooltip de VM parada oferece Up e mostra erros', () => {
  const m: Machine = { name: 'db', state: 'poweroff', stateLabel: 'poweroff', provider: 'virtualbox', cwd: '/p/lab' };
  const md = renderTooltip(m, { syncedFolders: [], errors: ['VBoxManage: falhou'] }).value;
  assert.match(md, /command:vagrantManager\.up\?/);
  assert.match(md, /falhou/);
});
