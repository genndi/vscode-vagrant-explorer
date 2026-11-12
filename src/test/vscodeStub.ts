/**
 * Stub mínimo do módulo `vscode` para rodar os testes no Node puro.
 * Importe este arquivo ANTES de qualquer módulo da extensão.
 */
import Module = require('module');

const format = (message: string, ...args: unknown[]) =>
  message.replace(/\{(\d+)\}/g, (match, i) => (args[Number(i)] !== undefined ? String(args[Number(i)]) : match));

class MarkdownString {
  value = '';
  supportHtml = false;
  isTrusted: unknown;
  constructor(value = '', public supportThemeIcons = false) {
    this.value = value;
  }
  appendMarkdown(s: string): this {
    this.value += s;
    return this;
  }
}

/** Configurações que os testes podem sobrescrever. */
export const config: Record<string, unknown> = {};

export const vscodeStub = {
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, def?: T) => (key in config ? (config[key] as T) : def),
    }),
  },
  l10n: { t: format },
  env: { language: 'en' },
  MarkdownString,
};

type Loader = (request: string, ...rest: unknown[]) => unknown;
const mod = Module as unknown as { _load: Loader };
const original = mod._load;
mod._load = function (this: unknown, request: string, ...rest: unknown[]) {
  return request === 'vscode' ? vscodeStub : original.call(this, request, ...rest);
};
