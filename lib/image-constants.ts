export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const MAX_IMAGES_PER_UPLOAD = 5;

export const MAX_IMAGE_WIDTH = 4096;

export const MAX_IMAGE_HEIGHT = 4096;

export const MAX_IMAGE_PIXELS = 16_000_000;

export const MAX_IMAGES_PER_MESSAGE = 5;

export const MAX_IMAGES_PER_INVOCATION = 5;

export const MAX_IMAGE_PROMPT_BYTES = 12 * 1024 * 1024;

export const ALLOWED_IMAGE_MIME_TYPES: ReadonlyArray<string> = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

export const ALLOWED_IMAGE_EXTENSIONS: ReadonlyArray<string> = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

export const STAGED_IMAGE_TTL_MS = 24 * 60 * 60 * 1000;

export const UPLOAD_LEASE_TTL_MS = 10 * 60 * 1000;

export const UPLOAD_RETRY_AFTER_MS = 15 * 1000;
