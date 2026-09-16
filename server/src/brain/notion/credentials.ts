import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';

export type PendingAuthorization = {
  state: string;
  verifier?: string;
  expiresAt: number;
};

export type NotionCredentials = {
  redirectUrl?: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  tokenExpiresAt?: number;
  discovery?: OAuthDiscoveryState;
  pending?: PendingAuthorization;
  reconnectRequired?: boolean;
  workspace?: string;
  lastCheckedAt?: string;
};

export class CredentialStore {
  private readonly key: Buffer;

  constructor(
    private readonly path: string,
    secret: string,
  ) {
    this.key = createHash('sha256').update(secret).digest();
  }

  async read(): Promise<NotionCredentials> {
    let content: string;
    try {
      content = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      throw error;
    }
    const payload = JSON.parse(content);
    if (payload.version !== 1) {
      throw new Error('Unsupported credential format.');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8')) as NotionCredentials;
  }

  async write(value: NotionCredentials): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    const payload = {
      version: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(payload), { flag: 'wx', mode: 0o600 });
      await rename(temporaryPath, this.path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}
