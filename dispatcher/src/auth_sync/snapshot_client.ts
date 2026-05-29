import * as https from 'node:https';
import * as fs from 'node:fs';
import { logger } from '../utils/logger.js';

export interface SnapshotUser {
  operatorId: string;
  passwordHash: string;
  role: string;
  active: boolean;
  updatedAt: string;
}

export interface AuthSnapshot {
  version: number;
  users: SnapshotUser[];
  checksum: string;
}

export class SnapshotClient {
  private agent: https.Agent;
  private url: string;

  constructor() {
    this.url = process.env.BACKEND_SNAPSHOT_URL || 'https://web-backend:8080/api/auth/snapshot';
    
    const certPath = process.env.DISPATCHER_CERT || './certs/dispatcher.crt';
    const keyPath = process.env.DISPATCHER_KEY || './certs/dispatcher.key';
    const caPath = process.env.BACKEND_CA_CERT || './certs/backend-ca.crt';

    try {
      this.agent = new https.Agent({
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
        ca: fs.readFileSync(caPath),
        rejectUnauthorized: true,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to load mTLS certificates for SnapshotClient');
      throw err;
    }
  }

  async fetchSnapshot(since: number): Promise<AuthSnapshot> {
    const fetchUrl = `${this.url}?since=${since}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    return new Promise((resolve, reject) => {
      const req = https.get(fetchUrl, {
        agent: this.agent,
        signal: controller.signal,
      }, (res) => {
        clearTimeout(timeout);
        
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(new Error('Failed to parse snapshot response'));
            }
          } else {
            reject(new Error(`Snapshot request failed with status ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      req.end();
    });
  }
}
