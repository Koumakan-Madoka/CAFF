// Local configuration evidence only: never probes credentials or an upstream.
function text(value: any) {
  return typeof value === 'string' ? value.trim() : '';
}

export function inspectModelConfiguration(modelCatalog: any, config: any) {
  let modelOptions: any[] = [];
  let resolvedModel: any = null;
  let code = '';
  try {
    const options = modelCatalog?.getOptions?.();
    modelOptions = (Array.isArray(options) ? options : []).map((option: any) => {
      if (typeof option?.runtimeResolvable === 'boolean') return option;
      const resolved = modelCatalog?.getResolvedModel?.(option?.provider, option?.model);
      const verified = resolved?.runtimeResolvable === true
        && text(resolved.provider) === text(option?.provider)
        && text(resolved.model) === text(option?.model);
      return {
        ...option,
        ...(verified ? { supportedThinkingLevels: resolved.supportedThinkingLevels } : {}),
        runtimeResolvable: verified,
      };
    });
    if (!text(config?.provider) || !text(config?.model)) {
      code = 'model_unconfigured';
    } else {
      resolvedModel = modelOptions.find((option) => text(option?.provider) === text(config.provider)
        && text(option?.model) === text(config.model))
        || modelCatalog?.getResolvedModel?.(config.provider, config.model);
      if (resolvedModel?.runtimeResolvable !== true
        || text(resolvedModel.provider) !== text(config.provider)
        || text(resolvedModel.model) !== text(config.model)) {
        code = 'model_unavailable';
      } else if (text(config.thinking) && (!Array.isArray(resolvedModel.supportedThinkingLevels)
        || !resolvedModel.supportedThinkingLevels.includes(config.thinking))) {
        code = 'thinking_unsupported';
      }
      if (resolvedModel?.runtimeResolvable === true && !modelOptions.includes(resolvedModel) && !code) {
        modelOptions = [...modelOptions, { ...resolvedModel, sourceLabel: 'explicit setting' }];
      }
    }
  } catch {
    code = 'catalog_unavailable';
  }
  return {
    ready: !code,
    code,
    path: code === 'thinking_unsupported' ? 'body.thinking' : code ? 'body.model' : '',
    modelOptions: structuredClone(modelOptions),
    resolvedModel: !code ? resolvedModel : null,
  };
}
