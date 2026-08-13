import { MAX_IMAGES_PER_INVOCATION, MAX_IMAGE_PROMPT_BYTES } from '../../../../lib/image-constants';

export const IMAGE_UNREADABLE_PLACEHOLDER = '[一张图片，但是你没有读取图片的能力]';

function normalize(value: any) {
  return typeof value === 'string' ? value.trim() : '';
}

export function imageMarkerFor(messageOrdinal: number, imageOrdinal: number) {
  return `[image:${messageOrdinal}:${imageOrdinal}]`;
}

export function messageImageBlocks(message: any) {
  const metadata = message && message.metadata && typeof message.metadata === 'object'
    ? message.metadata
    : null;
  const blocks = metadata && Array.isArray(metadata.contentBlocks) ? metadata.contentBlocks : [];
  return blocks.filter((block: any) => block && block.type === 'image');
}

function ordinalText(text: any, marker: string, hadText: boolean) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return hadText ? `\n${marker}` : marker;
  }
  return hadText ? `${normalized}\n${marker}` : `${normalized}\n${marker}`;
}

export function projectMultimodalPrompt(messages: any, options: any = {}) {
  const maxMessages = Number.isInteger(options.maxMessages) ? options.maxMessages : 24;
  const maxImages = Number.isInteger(options.maxImages) ? options.maxImages : MAX_IMAGES_PER_INVOCATION;
  const maxPromptBytes = Number.isInteger(options.maxPromptBytes) ? options.maxPromptBytes : MAX_IMAGE_PROMPT_BYTES;
  const readImage = typeof options.readImage === 'function' ? options.readImage : null;

  const windowed = (Array.isArray(messages) ? messages : []).slice(-maxMessages);
  const textParts: string[] = [];
  const images: any[] = [];
  const missingImages: any[] = [];
  let projectedBytes = 0;
  let budgetExceeded = false;
  let budgetReason = '';

  for (let messageOrdinal = 0; messageOrdinal < windowed.length; messageOrdinal += 1) {
    const message = windowed[messageOrdinal];
    if (!message || message.role !== 'user') {
      textParts.push(String(message && message.content || '').trim() || '');
      continue;
    }

    const imageBlocks = messageImageBlocks(message);
    const text = String(message && message.content || '').trim();

    if (imageBlocks.length === 0) {
      textParts.push(text);
      continue;
    }

    let messageText = '';
    let hadText = false;
    if (text) {
      messageText = text;
      hadText = true;
    }

    for (let imageOrdinal = 0; imageOrdinal < imageBlocks.length; imageOrdinal += 1) {
      const block = imageBlocks[imageOrdinal];
      const marker = imageMarkerFor(messageOrdinal, imageOrdinal);
      messageText = ordinalText(messageText, marker, hadText);
      hadText = true;

      if (budgetExceeded) {
        continue;
      }

      let bytes: Buffer | null = null;
      if (readImage) {
        try {
          bytes = readImage(block);
        } catch {
          bytes = null;
        }
      }

      if (bytes === null || bytes === undefined) {
        missingImages.push({
          marker,
          imageId: String(block.imageId || '').trim(),
          url: String(block.url || '').trim(),
        });
        continue;
      }

      const byteLength = bytes.length;
      if (images.length + 1 > maxImages) {
        budgetExceeded = true;
        budgetReason = 'image_count';
        images.length = 0;
        missingImages.length = 0;
        textParts.length = 0;
        return { text: '', images: [], missingImages: [], projectedMessages: [], budgetExceeded, budgetReason };
      }

      if (projectedBytes + byteLength > maxPromptBytes) {
        budgetExceeded = true;
        budgetReason = 'image_bytes';
        images.length = 0;
        missingImages.length = 0;
        textParts.length = 0;
        return { text: '', images: [], missingImages: [], projectedMessages: [], budgetExceeded, budgetReason };
      }

      projectedBytes += byteLength;
      images.push({
        marker,
        imageId: String(block.imageId || '').trim(),
        url: String(block.url || '').trim(),
        bytes,
        byteLength,
      });
    }

    textParts.push(messageText);
  }

  return {
    text: textParts.filter(Boolean).join('\n\n').trim(),
    images,
    missingImages,
    projectedMessages: projectMessagesWithMarkers(windowed, { maxMessages }),
    budgetExceeded,
    budgetReason,
  };
}

export function projectMessagesWithMarkers(messages: any, options: any = {}) {
  const maxMessages = Number.isInteger(options.maxMessages) ? options.maxMessages : 24;
  const windowed = (Array.isArray(messages) ? messages : []).slice(-maxMessages);

  return windowed.map((message: any, messageOrdinal: number) => {
    if (!message || message.role !== 'user') {
      return message;
    }

    const imageBlocks = messageImageBlocks(message);

    if (imageBlocks.length === 0) {
      return message;
    }

    const text = String(message && message.content || '').trim();
    let messageText = text;
    let hadText = Boolean(messageText);

    for (let imageOrdinal = 0; imageOrdinal < imageBlocks.length; imageOrdinal += 1) {
      const marker = imageMarkerFor(messageOrdinal, imageOrdinal);
      messageText = ordinalText(messageText, marker, hadText);
      hadText = true;
    }

    return {
      ...message,
      content: messageText,
    };
  });
}

export function projectMessagesWithImagePlaceholders(messages: any, options: any = {}) {
  const maxMessages = Number.isInteger(options.maxMessages) ? options.maxMessages : 24;
  const windowed = (Array.isArray(messages) ? messages : []).slice(-maxMessages);

  return windowed.map((message: any) => {
    if (!message || message.role !== 'user') {
      return message;
    }

    const imageBlocks = messageImageBlocks(message);
    if (imageBlocks.length === 0) {
      return message;
    }

    const text = String(message.content || '').trim();
    const contentParts = text ? [text] : [];
    for (let index = 0; index < imageBlocks.length; index += 1) {
      contentParts.push(IMAGE_UNREADABLE_PLACEHOLDER);
    }

    return {
      ...message,
      content: contentParts.join('\n'),
    };
  });
}

export function buildProjectedHistoryText(messages: any, options: any = {}) {
  const maxMessages = Number.isInteger(options.maxMessages) ? options.maxMessages : 24;
  const windowed = (Array.isArray(messages) ? messages : []).slice(-maxMessages);
  const textParts: string[] = [];

  for (let messageOrdinal = 0; messageOrdinal < windowed.length; messageOrdinal += 1) {
    const message = windowed[messageOrdinal];
    const imageBlocks = messageImageBlocks(message);
    const text = String(message && message.content || '').trim();

    if (!message || message.role !== 'user' || imageBlocks.length === 0) {
      textParts.push(text);
      continue;
    }

    let messageText = text;
    let hadText = Boolean(messageText);

    for (let imageOrdinal = 0; imageOrdinal < imageBlocks.length; imageOrdinal += 1) {
      const marker = imageMarkerFor(messageOrdinal, imageOrdinal);
      messageText = ordinalText(messageText, marker, hadText);
      hadText = true;
    }

    textParts.push(messageText);
  }

  return textParts.filter(Boolean).join('\n\n').trim();
}
