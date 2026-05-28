// File storage backends — abstracts local disk vs S3-compatible.
// Selected via STORAGE_BACKEND env var (disk | s3).

import { promises as fs, createReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Response } from "express";

export interface StorageBackend {
  readonly kind: "disk" | "s3";
  upload(buffer: Buffer, key: string, contentType: string): Promise<{ key: string; url?: string }>;
  signedUrl(key: string, expiresIn?: number): Promise<string | null>;
  /** Stream a file directly to an Express response. Returns false if not found / unsupported. */
  streamTo(key: string, res: Response): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Public-facing URL (CDN/base) when available; otherwise null and caller should use /api/files/:id. */
  publicUrl(key: string): string | null;
}

const UPLOAD_ROOT = process.env.LOCAL_UPLOAD_ROOT || "/app/data/uploads";

class LocalDiskBackend implements StorageBackend {
  readonly kind = "disk" as const;

  async upload(buffer: Buffer, key: string, _contentType: string) {
    const full = join(UPLOAD_ROOT, key);
    await mkdir(dirname(full), { recursive: true });
    await fs.writeFile(full, buffer);
    return { key };
  }

  async signedUrl(_key: string) {
    // Disk backend doesn't support signed URLs — clients fetch via /api/files/:id
    return null;
  }

  async streamTo(key: string, res: Response) {
    const full = join(UPLOAD_ROOT, key);
    try {
      const stat = await fs.stat(full);
      res.setHeader("Content-Length", String(stat.size));
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(full);
        stream.on("error", reject);
        stream.on("end", resolve);
        stream.pipe(res);
      });
      return true;
    } catch (err: any) {
      if (err?.code === "ENOENT") return false;
      throw err;
    }
  }

  async delete(key: string) {
    const full = join(UPLOAD_ROOT, key);
    try { await fs.unlink(full); } catch (err: any) { if (err?.code !== "ENOENT") throw err; }
  }

  publicUrl(_key: string) { return null; }
}

class S3Backend implements StorageBackend {
  readonly kind = "s3" as const;
  private s3: any;
  private bucket: string;
  private publicBase: string | null;
  private prefix: string; // e.g. "chat/" — namespaces this app in a shared bucket

  constructor(s3: any, bucket: string, publicBase: string | null, prefix = "") {
    this.s3 = s3;
    this.bucket = bucket;
    this.publicBase = publicBase;
    // Normalize: ensure trailing slash, never leading slash
    this.prefix = prefix ? prefix.replace(/^\/+/, "").replace(/\/?$/, "/") : "";
  }

  private fullKey(key: string) {
    return this.prefix + key.replace(/^\/+/, "");
  }

  async upload(buffer: Buffer, key: string, contentType: string) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const fullKey = this.fullKey(key);
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket, Key: fullKey, Body: buffer, ContentType: contentType,
    }));
    return { key, url: this.publicUrl(key) ?? undefined };
  }

  async signedUrl(key: string, expiresIn = 3600) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }), { expiresIn });
  }

  async streamTo(key: string, res: Response) {
    // Prefer redirecting to a signed URL for S3 — caller decides via /api/files/:id route.
    const url = await this.signedUrl(key, 600);
    if (!url) return false;
    res.redirect(url);
    return true;
  }

  async delete(key: string) {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }));
  }

  publicUrl(key: string) {
    if (!this.publicBase) return null;
    return `${this.publicBase.replace(/\/$/, "")}/${this.fullKey(key)}`;
  }
}

let _backend: StorageBackend | null = null;
export function getStorageBackend(): StorageBackend {
  if (_backend) return _backend;
  const kind = (process.env.STORAGE_BACKEND || "disk").toLowerCase();
  if (kind === "s3" && process.env.S3_BUCKET && process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY) {
    // Lazy require so disk-only deployments don't pay the cost
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { S3Client } = require("@aws-sdk/client-s3");
      const s3 = new S3Client({
        region: process.env.S3_REGION || "us-east-1",
        endpoint: process.env.S3_ENDPOINT || undefined,
        forcePathStyle: !!process.env.S3_ENDPOINT,
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY!,
          secretAccessKey: process.env.S3_SECRET_KEY!,
        },
      });
      const prefix = process.env.S3_KEY_PREFIX || "chat/";
      _backend = new S3Backend(s3, process.env.S3_BUCKET!, process.env.S3_PUBLIC_URL_BASE || null, prefix);
      console.log(`[storage] Using S3 backend bucket=${process.env.S3_BUCKET} prefix=${prefix} endpoint=${process.env.S3_ENDPOINT || "(aws)"}`);
      return _backend;
    } catch (err) {
      console.warn("[storage] Falling back to disk; S3 init failed:", err);
    }
  }
  _backend = new LocalDiskBackend();
  console.log(`[storage] Using local disk backend at ${UPLOAD_ROOT}`);
  return _backend;
}
