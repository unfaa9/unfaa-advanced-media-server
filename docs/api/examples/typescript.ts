// Minimal typed client (Node 20+ / browsers' fetch). Server-side only: it holds the API key.
const MEDIA = process.env.MEDIA_URL ?? "https://media.unfaa.com";
const KEY = process.env.MEDIA_KEY!;

export interface MediaFile {
  id: string;
  status: "pending" | "active" | "deleted" | "purged";
  visibility: "public" | "private" | "sensitive";
  kind: "image" | "video" | "document";
  mime: string;
  size: number;
  original_size: number;
  url?: string; // public files only
  variants_url_template?: string;
}

export class MediaError extends Error {
  constructor(public status: number, public code: string, public detail: string, public requestId: string) {
    super(`${status} ${code}: ${detail}`);
  }
  get retryable() {
    return this.status === 429 || this.status >= 500;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${MEDIA}/api/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${KEY}`, ...(init.headers as Record<string, string>) },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new MediaError(res.status, body.code ?? "unknown", body.detail ?? "", body.request_id ?? "");
  return body as T;
}

export const media = {
  upload(file: Blob, name: string, opts: { visibility: string; confirm?: boolean; purpose?: string; ownerRef?: string; account?: string; actor?: string; idempotencyKey?: string }) {
    const q = new URLSearchParams({ visibility: opts.visibility });
    if (opts.confirm) q.set("confirm", "true");
    if (opts.purpose) q.set("purpose", opts.purpose);
    if (opts.ownerRef) q.set("owner_ref", opts.ownerRef);
    if (opts.account) q.set("account", opts.account);
    if (opts.actor) q.set("actor", opts.actor);
    const form = new FormData();
    form.append("file", file, name);
    return call<MediaFile>(`/files?${q}`, {
      method: "POST",
      body: form,
      headers: opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {},
    });
  },
  confirm: (id: string, ownerRef?: string) =>
    call<MediaFile>(`/files/${id}/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ owner_ref: ownerRef }) }),
  confirmBatch: (ids: string[], ownerRef?: string) =>
    call<{ data: MediaFile[] }>(`/files/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids, owner_ref: ownerRef }) }),
  remove: (id: string) => call<void>(`/files/${id}`, { method: "DELETE" }),
  signedUrl: (id: string, body: { ttl?: number; variant?: { w: number; fmt: string }; actor?: string; reason?: string } = {}) =>
    call<{ url: string; expires_at?: string }>(`/files/${id}/signed-url`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
};
