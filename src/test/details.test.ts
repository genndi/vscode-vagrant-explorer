import './vscodeStub';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseGuestProperties, parseShowVmInfo } from '../details';
import { GUESTPROPS_V6, GUESTPROPS_V7, SHOWVMINFO } from './fixtures';

test('parseShowVmInfo lê recursos e identificação', () => {
  const info = parseShowVmInfo(SHOWVMINFO);
  assert.equal(info.vmName, 'lab_router_1731360000');
  assert.equal(info.osType, 'Red Hat (64-bit)');
  assert.equal(info.memoryMb, 2048);
  assert.equal(info.cpus, 2);
  assert.equal(info.vramMb, 16);
  assert.equal(info.stateSince, '2026-11-11T22:30:38.269000000');
});

test('parseShowVmInfo lê as placas, pula "none" e formata o MAC', () => {
  const { nics } = parseShowVmInfo(SHOWVMINFO);
  assert.deepEqual(
    nics.map((n) => [n.index, n.type, n.network]),
    [
      [1, 'nat', 'NAT'],
      [2, 'intnet', 'lab-lan'],
      [3, 'intnet', 'lab-wan'],
      [5, 'hostonly', 'vboxnet0'],
      [6, 'bridged', 'enp7s0'],
    ],
  );
  assert.equal(nics[0].mac, '08:00:27:A0:00:00');
  assert.equal(nics[2].connected, false);
  assert.equal(nics[1].connected, true);
});

test('parseShowVmInfo lê os port forwards (host IP vazio vira 0.0.0.0)', () => {
  const { forwards } = parseShowVmInfo(SHOWVMINFO);
  assert.deepEqual(forwards, [
    { name: 'ssh', protocol: 'tcp', hostIp: '127.0.0.1', hostPort: '2222', guestPort: '22' },
    { name: 'web', protocol: 'tcp', hostIp: '0.0.0.0', hostPort: '8080', guestPort: '80' },
  ]);
});

test('parseShowVmInfo para na primeira placa ausente', () => {
  const { nics } = parseShowVmInfo('nic1="nat"\nnic3="intnet"\nintnet3="x"\n');
  assert.equal(nics.length, 1);
});

test('parseShowVmInfo entende host-only network do VirtualBox 7 (macOS)', () => {
  const { nics } = parseShowVmInfo('nic1="hostonlynetwork"\nhostonly-network1="HostNet"\n');
  assert.deepEqual([nics[0].type, nics[0].network], ['hostonlynetwork', 'HostNet']);
});

test('parseShowVmInfo tolera saída vazia ou números inválidos', () => {
  const info = parseShowVmInfo('memory="muito"\n');
  assert.equal(info.memoryMb, undefined);
  assert.equal(info.vmName, '');
  assert.deepEqual(info.nics, []);
});

test('parseGuestProperties: formato do VirtualBox 7', () => {
  const ips = parseGuestProperties(GUESTPROPS_V7);
  assert.deepEqual(ips.get('080027A00000'), { ip: '10.0.2.15', mask: '255.255.255.0' });
  assert.deepEqual(ips.get('080027A00013'), { ip: '192.168.56.10', mask: '255.255.255.0' });
  // Placa sem IP não entra.
  assert.equal(ips.has('080027A00010'), false);
  assert.equal(ips.size, 2);
});

test('parseGuestProperties: formato do VirtualBox 6', () => {
  const ips = parseGuestProperties(GUESTPROPS_V6);
  assert.deepEqual(ips.get('080027A00000'), { ip: '10.0.2.15', mask: undefined });
  assert.deepEqual(ips.get('080027A00011'), { ip: '172.16.0.1', mask: '255.255.0.0' });
});

test('parseGuestProperties: saída vazia', () => {
  assert.equal(parseGuestProperties('').size, 0);
});
