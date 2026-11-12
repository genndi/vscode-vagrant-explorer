import './vscodeStub';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseMachineReadable } from '../vagrant';
import { STATUS_MR } from './fixtures';

test('parseMachineReadable separa alvo, tipo e dados', () => {
  const lines = parseMachineReadable(STATUS_MR);
  const state = lines.filter((l) => l.type === 'state');
  assert.deepEqual(
    state.map((l) => [l.target, l.data[0]]),
    [
      ['web', 'running'],
      ['db', 'not_created'],
    ],
  );
});

test('parseMachineReadable restaura vírgulas e quebras de linha escapadas', () => {
  const long = parseMachineReadable(STATUS_MR).find((l) => l.type === 'state-human-long');
  assert.ok(long);
  assert.equal(long.data[0], 'The VM is running. To stop this VM, you can run `vagrant halt`\nto shut it down.');
});

test('parseMachineReadable mantém alvo vazio e ignora linhas em branco ou curtas', () => {
  const lines = parseMachineReadable('\n\n1731360000,,ui,info,hello\nlixo\n1,2\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], { target: '', type: 'ui', data: ['info', 'hello'] });
});

test('parseMachineReadable aceita CRLF', () => {
  const lines = parseMachineReadable('1,web,state,running\r\n1,web,provider-name,virtualbox\r\n');
  assert.deepEqual(
    lines.map((l) => l.data[0]),
    ['running', 'virtualbox'],
  );
});
