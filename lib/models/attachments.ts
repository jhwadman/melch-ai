/**
 * lib/models/attachments.ts — which files a model's path takes in a user
 * message, and how large.
 *
 * WHY this file exists:
 *   A file reaches a model as a blob part, and what an adapter can send
 *   differs by provider: Gemini takes audio and video, the Messages API and
 *   the Responses API take PDFs, a chat-completions path takes images only. A
 *   caller that converts or shrinks a file first (the desktop app), and the
 *   A2A server that refuses one, read the same table, so neither learns of a
 *   mismatch from a provider's 400.
 *
 * Limits are the provider's published ones, set a little under where the
 * base64 a request carries is what is counted. `maxRequestBytes` is decoded
 * bytes across a whole request, and a conversation's earlier files are in it.
 */

import { planTransport } from './gateway.ts';
import type { ProviderId } from './providerMap.ts';

const MB = 1024 * 1024;

export interface AttachmentSupport {
  /** Image types sent as images. */
  images: readonly string[];
  /** Document types sent as documents; anything else must arrive as text. */
  documents: readonly string[];
  /** Audio and video types sent as they are. */
  media: readonly string[];
  /** The longest image edge worth sending, in pixels: past it the provider shrinks the image or refuses it. */
  maxImageEdge: number;
  /** Largest image, decoded bytes. */
  maxImageBytes: number;
  /** Largest document or media file, decoded bytes. */
  maxFileBytes: number;
  /** Largest total of files in one request, decoded bytes. */
  maxRequestBytes: number;
}

/** Any path that takes a data URI: the chat-completions adapters, Ollama and the gateways. */
const PLAIN: AttachmentSupport = {
  images: ['image/jpeg', 'image/png'],
  documents: [],
  media: [],
  maxImageEdge: 1568,
  maxImageBytes: 8 * MB,
  maxFileBytes: 0,
  maxRequestBytes: 14 * MB,
};

const DIRECT: Partial<Record<ProviderId, AttachmentSupport>> = {
  anthropic: {
    images: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    documents: ['application/pdf'],
    media: [],
    maxImageEdge: 1568,
    maxImageBytes: 3.75 * MB,
    maxFileBytes: 22 * MB,
    maxRequestBytes: 22 * MB,
  },
  openai: {
    images: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    documents: ['application/pdf'],
    media: [],
    maxImageEdge: 2048,
    maxImageBytes: 20 * MB,
    maxFileBytes: 32 * MB,
    maxRequestBytes: 36 * MB,
  },
  gemini: {
    images: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
    documents: ['application/pdf'],
    media: [
      'audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/aiff', 'audio/aac', 'audio/ogg', 'audio/flac',
      'video/mp4', 'video/mpeg', 'video/quicktime', 'video/webm',
    ],
    maxImageEdge: 3072,
    maxImageBytes: 14 * MB,
    maxFileBytes: 14 * MB,
    maxRequestBytes: 14 * MB,
  },
};

/**
 * What `model` takes on the path it will actually run on. A gateway speaks
 * chat completions whichever provider is behind it, so a direct-only type is
 * not offered there. An id no path serves reads as the plain table.
 */
export function attachmentSupport(model: unknown, opts: { callerKey?: boolean } = {}): AttachmentSupport {
  if (typeof model !== 'string' || !model) return PLAIN;
  try {
    const plan = planTransport(model, opts);
    return (plan.transport === 'direct' && DIRECT[plan.provider]) || PLAIN;
  } catch {
    return PLAIN;
  }
}

/** Whether a media type is sent as a blob on this path (not whether it fits). */
export function takesBlob(support: AttachmentSupport, mediaType: string): boolean {
  return support.images.includes(mediaType) || support.documents.includes(mediaType) || support.media.includes(mediaType);
}
