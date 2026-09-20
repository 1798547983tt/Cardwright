import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SecretCodec { encrypt(value: string): Buffer; decrypt(value: Buffer): string }

/** Only encrypted ciphertext is persisted. This class never exposes keys in snapshots. */
export class Vault {
  private file: string;
  private secrets: Record<string, string>;
  private codec: SecretCodec;
  constructor(directory: string, codec: SecretCodec) {
    mkdirSync(directory, { recursive: true });
    this.file = join(directory, 'credentials.enc.json');
    this.codec = codec;
    this.secrets = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {};
  }
  get(id: string): string {
    return this.secrets[id] ? this.codec.decrypt(Buffer.from(this.secrets[id], 'base64')) : '';
  }
  has(id: string): boolean { return Boolean(this.secrets[id]); }
  set(id: string, secret: string): void {
    const next = { ...this.secrets };
    if (secret) next[id] = this.codec.encrypt(secret).toString('base64');
    else delete next[id];
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    renameSync(temporary, this.file);
    this.secrets = next;
  }
}
