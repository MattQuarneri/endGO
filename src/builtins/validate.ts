import type { endGOMiddleware, endGORequest, MiddlewareContext } from '../types.js';

/**
 * Standard Schema v1 interface (zero runtime dependencies).
 * Compatible with Zod v3.24+/v4, Valibot, ArkType, or any custom Standard Schema.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}

export declare namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown
    ) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }

  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }

  export type Result<Output> = SuccessResult<Output> | FailureResult;

  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }

  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }

  export interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }

  export interface PathSegment {
    readonly key: PropertyKey;
  }

  export type InferInput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['input'];

  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['output'];
}

/**
 * Request parts supported by {@link validate}.
 */
export type ValidationTarget = 'json' | 'query' | 'params' | 'headers';

/**
 * Schema map accepted by {@link validate}.
 */
export interface ValidationSchemas<
  TJson extends StandardSchemaV1 = StandardSchemaV1,
  TQuery extends StandardSchemaV1 = StandardSchemaV1,
  TParams extends StandardSchemaV1 = StandardSchemaV1,
  THeaders extends StandardSchemaV1 = StandardSchemaV1,
> {
  json?: TJson;
  query?: TQuery;
  params?: TParams;
  headers?: THeaders;
}

/**
 * Structured error payload produced when validation fails.
 */
export interface ValidationErrorPayload {
  error: 'Validation Failed';
  target: ValidationTarget;
  issues: ReadonlyArray<StandardSchemaV1.Issue>;
}

/**
 * Options for {@link validate}.
 */
export interface ValidationOptions {
  onValidationError?: (
    payload: ValidationErrorPayload,
    context: MiddlewareContext
  ) => Response | Promise<Response>;
}

/**
 * Infers the validated output shape for a {@link ValidationSchemas} definition.
 */
export type ValidatedData<
  TSchemas extends ValidationSchemas = ValidationSchemas,
> = {
  [K in keyof TSchemas as Exclude<TSchemas[K], undefined> extends StandardSchemaV1
    ? K
    : never]: Exclude<TSchemas[K], undefined> extends StandardSchemaV1<
    any,
    infer TOutput
  >
    ? TOutput
    : never;
};

const VALIDATED_STORE = new WeakMap<endGORequest, Record<string, unknown>>();

/**
 * Retrieves validated data attached to `request` by {@link validate}.
 */
export function getValidated<
  TSchemas extends ValidationSchemas = ValidationSchemas,
>(request: endGORequest): ValidatedData<TSchemas> {
  return (VALIDATED_STORE.get(request) ?? {}) as ValidatedData<TSchemas>;
}

function buildErrorResponse(
  context: MiddlewareContext,
  target: ValidationTarget,
  issues: ReadonlyArray<StandardSchemaV1.Issue>,
  options?: ValidationOptions
): Response | Promise<Response> {
  const payload: ValidationErrorPayload = {
    error: 'Validation Failed',
    target,
    issues,
  };

  if (options?.onValidationError) {
    return options.onValidationError(payload, context);
  }

  return context.server.reply(400, payload);
}

/**
 * Validates request `json`, `query`, `params`, and/or `headers` against Standard Schema v1
 * validators, attaching parsed outputs to the request for {@link getValidated}.
 */
export function validate<TSchemas extends ValidationSchemas>(
  schemas: TSchemas,
  options?: ValidationOptions
): endGOMiddleware {
  return async (context, next) => {
    const validated: Record<string, unknown> = {
      ...(VALIDATED_STORE.get(context.request) ?? {}),
    };

    if (schemas.params) {
      const result = await schemas.params['~standard'].validate(
        context.request.resolved.params
      );
      if (result.issues) {
        return buildErrorResponse(context, 'params', result.issues, options);
      }
      validated.params = result.value;
    }

    if (schemas.query) {
      const result = await schemas.query['~standard'].validate(
        context.request.resolved.query
      );
      if (result.issues) {
        return buildErrorResponse(context, 'query', result.issues, options);
      }
      validated.query = result.value;
    }

    if (schemas.headers) {
      const headersObj = Object.fromEntries(
        context.request.resolved.headers.entries()
      );
      const result = await schemas.headers['~standard'].validate(headersObj);
      if (result.issues) {
        return buildErrorResponse(context, 'headers', result.issues, options);
      }
      validated.headers = result.value;
    }

    if (schemas.json) {
      let rawJson: unknown;
      try {
        rawJson = context.request.resolved.body
          ? await context.request.resolved.body.json()
          : undefined;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Invalid JSON body';
        return buildErrorResponse(context, 'json', [{ message }], options);
      }

      const result = await schemas.json['~standard'].validate(rawJson);
      if (result.issues) {
        return buildErrorResponse(context, 'json', result.issues, options);
      }
      validated.json = result.value;
    }

    VALIDATED_STORE.set(context.request, validated);
    return next();
  };
}
