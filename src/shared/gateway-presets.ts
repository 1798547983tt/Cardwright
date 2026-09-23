/**
 * Gateway presets (Q7, Q13, handoff §5.8): addresses for services the user runs on this computer. Cardwright bundles,
 * installs and manages none of them; it only fills the form and checks the connection. Nothing is added by default.
 */
import type { Gateway } from './types.ts';

export interface GatewayPreset {
  id: 'local-model' | 'local-proxy';
  name: { en: string; zh: string };
  protocol: Gateway['protocol'];
  /** Local model servers rarely check a key; a proxy has the downstream key the user configured in it. */
  keyOptional: boolean;
  addresses: Array<{ label: string; url: string }>;
  note: { en: string; zh: string };
}

export const GATEWAY_PRESETS: readonly GatewayPreset[] = [
  {
    id: 'local-model', name: { en: 'Local model', zh: '本地模型' }, protocol: 'openai-completions', keyOptional: true,
    addresses: [{ label: 'Ollama', url: 'http://127.0.0.1:11434/v1' }, { label: 'llama.cpp', url: 'http://127.0.0.1:8080/v1' }, { label: 'LM Studio', url: 'http://127.0.0.1:1234/v1' }],
    note: {
      en: 'A model server you run on this computer, such as Ollama, llama.cpp or LM Studio. Start it first; what the model will write is up to the model you choose. Leave the key empty and Cardwright sends the placeholder “local”.',
      zh: '你自己在本机运行的模型服务，例如 Ollama、llama.cpp、LM Studio。先把它启动起来；模型能写什么，取决于你选的模型本身。密钥可以留空，应用会发送占位值 local。',
    },
  },
  {
    id: 'local-proxy', name: { en: 'Local proxy gateway', zh: '本地代理网关' }, protocol: 'openai-completions', keyOptional: false,
    addresses: [{ label: 'CLIProxyAPI', url: 'http://127.0.0.1:8317/v1' }],
    note: {
      en: 'An OpenAI-compatible proxy you run yourself on this computer, for example CLIProxyAPI. Cardwright does not ship, install or manage it; enter the client key you set in its config. Whether your accounts may be used this way is for you to check.',
      zh: '你自己在本机运行的 OpenAI 兼容代理，例如 CLIProxyAPI。Cardwright 不附带、不安装、也不管理它；密钥填你在它的配置里给客户端设的那一个。账号能不能这样用，请你自己确认服务条款。',
    },
  },
];

/** Whether an address points at this computer: 127.0.0.0/8, localhost or ::1. */
export function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'localhost' || host === '[::1]' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
  } catch { return false; }
}
