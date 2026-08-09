import {
  MAX_IMAGES_PER_INVOCATION,
  MAX_IMAGE_PROMPT_BYTES,
} from '../../../../lib/image-constants';
import { parseImageHeader } from '../../../../lib/image-header-parser';
import { projectMultimodalPrompt } from './multimodal-projection';

function normalize(value: any) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeModelInput(value: any) {
  const allowed = new Set(['text', 'image']);
  const entries = Array.isArray(value)
    ? value.map((entry: any) => String(entry || '').trim()).filter((entry: string) => allowed.has(entry))
    : [];
  return entries.length > 0 ? [...new Set(entries)] : ['text'];
}

function resolveAgentModel(agent: any) {
  const runtimeConfig = agent && agent.runtimeConfig && typeof agent.runtimeConfig === 'object'
    ? agent.runtimeConfig
    : null;
  if (runtimeConfig) {
    return {
      provider: normalize(runtimeConfig.provider),
      model: normalize(runtimeConfig.model),
    };
  }
  const selectedProfile = agent && agent.selectedModelProfile && typeof agent.selectedModelProfile === 'object'
    ? agent.selectedModelProfile
    : null;
  return {
    provider: normalize(selectedProfile ? selectedProfile.provider : agent && agent.provider),
    model: normalize(selectedProfile ? selectedProfile.model : agent && agent.model),
  };
}

export function resolveInvocationModelCapability(agent: any, modelCatalog: any) {
  const options = modelCatalog && typeof modelCatalog.getOptions === 'function'
    ? modelCatalog.getOptions()
    : Array.isArray(modelCatalog) ? modelCatalog : [];
  const byKey = new Map<string, any>();
  for (const option of options) {
    if (option && option.provider && option.model) {
      byKey.set(`${normalize(option.provider)}\u001f${normalize(option.model)}`, option);
    }
  }

  const { provider, model } = resolveAgentModel(agent);
  const option = provider && model ? byKey.get(`${provider}\u001f${model}`) : null;
  const input = normalizeModelInput(option && option.input);
  return {
    provider,
    model,
    input,
    supportsImage: input.includes('image'),
  };
}

function resolveImageMimeFromBytes(bytes: Buffer, persistedMime: string) {
  const parsed = parseImageHeader(bytes);

  if (!parsed.ok) {
    return {
      ok: false as const,
      code: 'IMAGE_MAGIC_BYTE_MISMATCH',
      reason: 'Image bytes do not match a supported image header',
    };
  }

  const canonical = parsed.header.mimeType;
  const persisted = String(persistedMime || '').trim();

  if (persisted && persisted !== canonical) {
    return {
      ok: false as const,
      code: 'IMAGE_MIME_MISMATCH',
      reason: `Persisted MIME ${persisted} does not match magic-byte ${canonical}`,
    };
  }

  return { ok: true as const, mimeType: canonical };
}

export function buildInvocationImages(options: any = {}) {
  const promptMessages = Array.isArray(options.promptMessages) ? options.promptMessages : [];
  const modelCatalog = options.modelCatalog;
  const agent = options.agent;
  const readImageBytes = typeof options.readImageBytes === 'function' ? options.readImageBytes : null;
  const imageMimeType = typeof options.imageMimeType === 'function' ? options.imageMimeType : null;
  const maxImagesPerInvocation = Number.isInteger(options.maxImagesPerInvocation)
    ? options.maxImagesPerInvocation
    : MAX_IMAGES_PER_INVOCATION;
  const maxImagePromptBytes = Number.isInteger(options.maxImagePromptBytes)
    ? options.maxImagePromptBytes
    : MAX_IMAGE_PROMPT_BYTES;

  const capability = resolveInvocationModelCapability(agent, modelCatalog);
  const maxMessages = Number.isInteger(options.maxMessages) ? options.maxMessages : 24;
  const windowedMessages = promptMessages.slice(-maxMessages);
  const hasImagesInWindow = windowedMessages.some((message: any) =>
    Array.isArray(message && message.contentBlocks)
    && message.contentBlocks.some((block: any) => block && block.type === 'image')
  );

  if (!hasImagesInWindow) {
    return { block: null, images: [], capability, projectedMessages: null };
  }

  if (!capability.supportsImage) {
    return {
      block: {
        code: 'MODEL_NO_IMAGE_INPUT',
        reason: `本次调用已阻断：模型不支持读取历史图片（${capability.provider || '?'}/${capability.model || '?'}）。`,
      },
      images: [],
      capability,
      projectedMessages: null,
    };
  }

  const projection = projectMultimodalPrompt(promptMessages, {
    maxMessages,
    maxImages: maxImagesPerInvocation,
    maxPromptBytes: maxImagePromptBytes,
    readImage: (block: any) => {
      if (!readImageBytes) {
        return null;
      }
      return readImageBytes(block);
    },
  });

  if (projection.budgetExceeded) {
    const reason = projection.budgetReason === 'image_count'
      ? `本次调用图片数量超过上限（${maxImagesPerInvocation} 张），已阻断而不截断。`
      : `本次调用图片字节总量超过上限，已阻断而不截断。`;
    return {
      block: {
        code: 'IMAGE_PROMPT_BUDGET_EXCEEDED',
        reason,
      },
      images: [],
      capability,
      projectedMessages: null,
    };
  }

  if (projection.missingImages.length > 0) {
    return {
      block: {
        code: 'IMAGE_CONTENT_UNAVAILABLE',
        reason: `历史图片文件不可用（${projection.missingImages.length} 张），已阻断该调用而非剥离图片。`,
        missingImageIds: projection.missingImages.map((image: any) => image.imageId),
      },
      images: [],
      capability,
      projectedMessages: null,
    };
  }

  const images: any[] = [];
  const resolvedMimeErrors: any[] = [];

  for (const image of projection.images) {
    const bytes = Buffer.isBuffer(image.bytes) ? image.bytes : Buffer.from(image.bytes || '');
    let mimeType: string | null = null;

    if (imageMimeType) {
      const candidate = String(imageMimeType(image.url, image) || '').trim();
      const resolved = resolveImageMimeFromBytes(bytes, candidate);

      if (!resolved.ok) {
        resolvedMimeErrors.push(resolved);
        continue;
      }

      mimeType = resolved.mimeType;
    } else {
      const resolved = resolveImageMimeFromBytes(bytes, '');

      if (!resolved.ok) {
        resolvedMimeErrors.push(resolved);
        continue;
      }

      mimeType = resolved.mimeType;
    }

    images.push({
      type: 'image' as const,
      data: bytes.toString('base64'),
      mimeType,
    });
  }

  if (resolvedMimeErrors.length > 0) {
    return {
      block: {
        code: resolvedMimeErrors[0].code,
        reason: resolvedMimeErrors[0].reason,
      },
      images: [],
      capability,
      projectedMessages: null,
    };
  }

  return {
    block: null,
    images,
    capability,
    projectedMessages: projection.projectedMessages,
  };
}
