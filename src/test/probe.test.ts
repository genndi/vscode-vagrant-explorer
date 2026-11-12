import './vscodeStub';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildProbeScript, hostPingArgs, parseProbeOutput, parsePingRtt, sanitizeTargets } from '../probe';

test('sanitizeTargets aceita só IPv4 válidos, sem repetir, e porta 1-65535', () => {
  assert.deepEqual(sanitizeTargets(['10.0.0.1', '10.0.0.1', '192.168.56.255', '256.1.1.1', '1.2.3', 'abc', 7, null], '22'), {
    ips: ['10.0.0.1', '192.168.56.255'],
    port: 22,
  });
  for (const bad of [0, 65536, '22; rm -rf /', 2.5, 'abc', null]) {
    assert.equal(sanitizeTargets([], bad).port, undefined, String(bad));
  }
  assert.deepEqual(sanitizeTargets('10.0.0.1', undefined).ips, []);
});

test('sanitizeTargets barra tentativas de injeção de comando', () => {
  const { ips } = sanitizeTargets(['10.0.0.1; reboot', '$(reboot)', '10.0.0.1 && id', '`id`', '10.0.0.2\n10.0.0.3'], undefined);
  assert.deepEqual(ips, []);
});

test('sanitizeTargets limita a quantidade de alvos', () => {
  const many = Array.from({ length: 100 }, (_, i) => `10.0.${Math.floor(i / 250)}.${i % 250}`);
  assert.equal(sanitizeTargets(many, undefined).ips.length, 64);
});

test('buildProbeScript (ping) testa cada IP em paralelo', () => {
  const s = buildProbeScript(['10.0.0.1', '10.0.0.2', 'x; reboot']);
  assert.match(s, /command -v ping/);
  assert.match(s, /ping -c 1 -W 2/);
  assert.match(s, /p 10\.0\.0\.1 & p 10\.0\.0\.2 & wait$/);
  assert.doesNotMatch(s, /reboot/);
});

test('buildProbeScript (TCP) usa bash /dev/tcp e cai para nc', () => {
  const s = buildProbeScript(['10.0.0.1'], 8080);
  assert.match(s, /\/dev\/tcp\/\$1\/8080/);
  assert.match(s, /nc -z -w 2 "\$1" 8080/);
  assert.doesNotMatch(s, /ping/);
  assert.match(s, /p 10\.0\.0\.1 & wait$/);
});

test('buildProbeScript ignora porta inválida e volta ao ping', () => {
  assert.match(buildProbeScript(['10.0.0.1'], 70000), /ping -c 1/);
});

test('parseProbeOutput lê ok com tempo, falha e ferramenta ausente', () => {
  const out = 'banner qualquer\nVMTEST 10.0.0.1 ok 0.219\nVMTEST 10.0.0.2 fail\r\nVMTEST 10.0.0.3 ok \nVMTEST 10.0.0.4 notool\nVMTEST 9.9.9.9 ok 1\n';
  assert.deepEqual(parseProbeOutput(out, ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4']).results, {
    '10.0.0.1': { status: 'ok', rttMs: 0.219 },
    '10.0.0.2': { status: 'fail', rttMs: undefined },
    '10.0.0.3': { status: 'ok', rttMs: undefined },
    '10.0.0.4': { status: 'notool', rttMs: undefined },
  });
});

test('parseProbeOutput: sem ping na VM, todos os alvos ficam "notool"', () => {
  assert.deepEqual(parseProbeOutput('VMTEST_NOTOOL\n', ['10.0.0.1', '10.0.0.2']).results, {
    '10.0.0.1': { status: 'notool' },
    '10.0.0.2': { status: 'notool' },
  });
});

test('hostPingArgs usa as opções de cada sistema', () => {
  assert.deepEqual(hostPingArgs('10.0.0.1', 'linux'), ['-c', '1', '-W', '2', '10.0.0.1']);
  assert.deepEqual(hostPingArgs('10.0.0.1', 'darwin'), ['-c', '1', '-t', '2', '10.0.0.1']);
  assert.deepEqual(hostPingArgs('10.0.0.1', 'win32'), ['-n', '1', '-w', '2000', '10.0.0.1']);
});

test('parsePingRtt entende Linux, macOS e Windows', () => {
  assert.equal(parsePingRtt('64 bytes from 10.0.0.1: icmp_seq=1 ttl=64 time=0.219 ms'), 0.219);
  assert.equal(parsePingRtt('64 bytes from 10.0.0.1: icmp_seq=0 ttl=64 time=1.042 ms'), 1.042);
  assert.equal(parsePingRtt('Reply from 10.0.0.1: bytes=32 time<1ms TTL=64'), 1);
  assert.equal(parsePingRtt('Reply from 10.0.0.1: bytes=32 time=12ms TTL=64'), 12);
  assert.equal(parsePingRtt('Request timed out.'), undefined);
});
