/**
 * WebMCP ModelContext implementation (`navigator.modelContext`).
 * Validates tool definitions, JSON Schema arguments, readOnlyHint annotations, and AbortSignal cancellation.
 */

const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function createInvalidParamsError(message) {
  const err = new Error(message);
  err.code = -32602;
  return err;
}

export function createAbortError(reason = 'Tool execution cancelled') {
  const err = new Error(typeof reason === 'string' ? reason : 'Tool execution cancelled');
  err.name = 'AbortError';
  err.code = -32800;
  return err;
}

export function validateToolDefinition(toolDef) {
  if (!toolDef || typeof toolDef !== 'object' || Array.isArray(toolDef)) {
    throw new TypeError('Tool definition must be an object');
  }

  const { name, description, inputSchema, annotations, execute } = toolDef;

  if (typeof name !== 'string' || !TOOL_NAME_RE.test(name)) {
    throw new TypeError(
      `Invalid tool name "${String(name)}": must match /^[a-zA-Z0-9_-]{1,64}$/`
    );
  }

  if (typeof description !== 'string' || !description.trim()) {
    throw new TypeError(`Tool "${name}" must provide a non-empty description string`);
  }

  if (typeof execute !== 'function') {
    throw new TypeError(`Tool "${name}" execute must be a function`);
  }

  let normalizedSchema = {
    type: 'object',
    properties: {},
    required: []
  };

  if (inputSchema !== undefined) {
    if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
      throw new TypeError(`Tool "${name}" inputSchema must be an object`);
    }
    if (inputSchema.type !== 'object') {
      throw new TypeError(`Tool "${name}" inputSchema.type must be "object"`);
    }
    normalizedSchema = {
      type: 'object',
      properties:
        inputSchema.properties && typeof inputSchema.properties === 'object'
          ? { ...inputSchema.properties }
          : {},
      required: Array.isArray(inputSchema.required) ? [...inputSchema.required] : [],
      ...(inputSchema.additionalProperties !== undefined
        ? { additionalProperties: inputSchema.additionalProperties }
        : {})
    };
  }

  const normalizedAnnotations = {
    ...(annotations && typeof annotations === 'object' ? annotations : {}),
    readOnlyHint: Boolean(annotations && annotations.readOnlyHint === true)
  };

  return {
    name,
    description: description.trim(),
    inputSchema: normalizedSchema,
    annotations: normalizedAnnotations,
    execute
  };
}

function checkType(propName, val, propSchema) {
  const expected = propSchema.type;
  if (!expected) return;

  if (expected === 'string') {
    if (typeof val !== 'string') {
      throw createInvalidParamsError(`Property "${propName}" must be of type string`);
    }
  } else if (expected === 'number') {
    if (typeof val !== 'number' || Number.isNaN(val)) {
      throw createInvalidParamsError(`Property "${propName}" must be of type number`);
    }
  } else if (expected === 'integer') {
    if (typeof val !== 'number' || !Number.isInteger(val)) {
      throw createInvalidParamsError(`Property "${propName}" must be of type integer`);
    }
  } else if (expected === 'boolean') {
    if (typeof val !== 'boolean') {
      throw createInvalidParamsError(`Property "${propName}" must be of type boolean`);
    }
  } else if (expected === 'array') {
    if (!Array.isArray(val)) {
      throw createInvalidParamsError(`Property "${propName}" must be of type array`);
    }
  } else if (expected === 'object') {
    if (!val || typeof val !== 'object' || Array.isArray(val)) {
      throw createInvalidParamsError(`Property "${propName}" must be of type object`);
    }
  }

  if (Array.isArray(propSchema.enum) && !propSchema.enum.includes(val)) {
    throw createInvalidParamsError(
      `Property "${propName}" must be one of enum [${propSchema.enum.join(', ')}]`
    );
  }
}

export function validateToolInput(inputSchema, rawInput) {
  const input = rawInput === undefined ? {} : rawInput;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw createInvalidParamsError('Tool input arguments must be a JSON object');
  }

  const schema = inputSchema || { type: 'object', properties: {} };
  const required = Array.isArray(schema.required) ? schema.required : [];
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};

  for (const reqKey of required) {
    if (!(reqKey in input) || input[reqKey] === undefined) {
      throw createInvalidParamsError(`Missing required property "${reqKey}"`);
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(input)) {
      if (!(key in properties)) {
        throw createInvalidParamsError(`Unknown property "${key}" is not allowed`);
      }
    }
  }

  for (const [key, val] of Object.entries(input)) {
    if (val === undefined) continue;
    const propSchema = properties[key];
    if (propSchema) {
      checkType(key, val, propSchema);
    }
  }

  return input;
}

export function createModelContext() {
  const tools = new Map();
  const listeners = new Set();

  function notify() {
    const current = listTools();
    for (const fn of listeners) {
      try {
        fn(current);
      } catch {
        // Ignore listener error
      }
    }
  }

  function registerTool(toolDef) {
    const validated = validateToolDefinition(toolDef);
    tools.set(validated.name, validated);
    notify();
    return {
      unregister() {
        unregisterTool(validated.name);
      }
    };
  }

  function unregisterTool(name) {
    const deleted = tools.delete(name);
    if (deleted) notify();
    return deleted;
  }

  function clearContext() {
    if (tools.size > 0) {
      tools.clear();
      notify();
    }
  }

  function listTools() {
    return Array.from(tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: structuredClone(t.inputSchema),
      annotations: structuredClone(t.annotations)
    }));
  }

  function getTool(name) {
    return tools.get(name) || null;
  }

  async function callTool(name, rawInput = {}, options = {}) {
    const tool = tools.get(name);
    if (!tool) {
      throw createInvalidParamsError(`Unknown tool "${String(name)}"`);
    }

    const validatedInput = validateToolInput(tool.inputSchema, rawInput);
    const controller = new AbortController();
    const externalSignal = options.signal;

    if (externalSignal) {
      if (externalSignal.aborted) {
        throw createAbortError(externalSignal.reason);
      }
      externalSignal.addEventListener(
        'abort',
        () => controller.abort(externalSignal.reason),
        { once: true }
      );
    }

    let abortListener;
    const abortPromise = new Promise((_resolve, reject) => {
      abortListener = () => {
        reject(createAbortError(controller.signal.reason));
      };
      controller.signal.addEventListener('abort', abortListener, { once: true });
    });

    try {
      return await Promise.race([
        Promise.resolve().then(() => tool.execute(validatedInput, { signal: controller.signal })),
        abortPromise
      ]);
    } finally {
      if (abortListener) {
        controller.signal.removeEventListener('abort', abortListener);
      }
    }
  }

  function onToolsChanged(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Listener must be a function');
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    registerTool,
    unregisterTool,
    clearContext,
    listTools,
    getTool,
    callTool,
    onToolsChanged
  };
}

export function installModelContext(nav = globalThis.navigator) {
  if (!nav) {
    return createModelContext();
  }
  if (!nav.modelContext) {
    const mc = createModelContext();
    try {
      Object.defineProperty(nav, 'modelContext', {
        value: mc,
        configurable: true,
        writable: false
      });
    } catch {
      nav.modelContext = mc;
    }
  }
  return nav.modelContext;
}
