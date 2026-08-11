import { arch, platform } from "node:os";

import { AzureMonitorTraceExporter } from "@azure/monitor-opentelemetry-exporter";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
    AlwaysOnSampler,
    BasicTracerProvider,
    SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
    ATTR_SERVICE_INSTANCE_ID,
    ATTR_SERVICE_NAME,
    ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

import { getOrCreateDeviceId } from "./device-id.mjs";
import { createUnrefHttpClient } from "./http-client.mjs";
import {
    TELEMETRY_ATTRIBUTE,
    TELEMETRY_CONNECTION_STRING_ENV,
    TELEMETRY_EVENT,
    TELEMETRY_EXPORTER_ENV,
    TELEMETRY_OPERATION,
    TELEMETRY_SERVICE_NAME,
    TELEMETRY_SUCCESS_OUTCOMES,
} from "../../public/telemetry-constants.js";
import {
    validateActionPayload,
    validateOperationPayload,
} from "./schema.mjs";

const BUNDLED_CONNECTION_STRING_BASE64 =
    typeof __FOUNDRY_CANVAS_APPINSIGHTS_CONNECTION_STRING_BASE64__ === "string"
        ? __FOUNDRY_CANVAS_APPINSIGHTS_CONNECTION_STRING_BASE64__
        : "";

function decodeBundledConnectionString(encoded) {
    if (!encoded) return "";
    try {
        return Buffer.from(encoded, "base64").toString("utf-8").trim();
    } catch {
        return "";
    }
}

function withTemporaryEnvironment(values, create) {
    const previous = new Map();
    for (const [name, value] of Object.entries(values)) {
        previous.set(name, process.env[name]);
        process.env[name] = value;
    }
    try {
        return create();
    } finally {
        for (const [name, value] of previous) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
}

export function createOtelEmitter({
    connectionString,
    productVersion,
    exporterFactory = (options) => new AzureMonitorTraceExporter(options),
    httpClient = createUnrefHttpClient(),
}) {
    const exporter = withTemporaryEnvironment(TELEMETRY_EXPORTER_ENV, () =>
        exporterFactory({
            connectionString,
            disableOfflineStorage: true,
            httpClient,
            retryOptions: { maxRetries: 0 },
        }));
    const provider = new BasicTracerProvider({
        resource: resourceFromAttributes({
            [ATTR_SERVICE_NAME]: TELEMETRY_SERVICE_NAME,
            [ATTR_SERVICE_VERSION]: productVersion,
            // The Azure Monitor exporter otherwise falls back to the machine
            // hostname for cloud_RoleInstance.
            [ATTR_SERVICE_INSTANCE_ID]: TELEMETRY_SERVICE_NAME,
        }),
        sampler: new AlwaysOnSampler(),
        spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const tracer = provider.getTracer(TELEMETRY_SERVICE_NAME, productVersion);

    return {
        emit(name, attributes, { failed = false } = {}) {
            const span = tracer.startSpan(name, {
                kind: SpanKind.INTERNAL,
                attributes,
            });
            span.setStatus({
                code: failed ? SpanStatusCode.ERROR : SpanStatusCode.OK,
            });
            span.end();
        },
        shutdown() {
            return provider.shutdown();
        },
    };
}

function operationAttributes(event, productVersion) {
    return {
        [TELEMETRY_ATTRIBUTE.OPERATION]: event.operation,
        [TELEMETRY_ATTRIBUTE.OUTCOME]: event.outcome,
        [TELEMETRY_ATTRIBUTE.DURATION_MS]: event.durationMs,
        [TELEMETRY_ATTRIBUTE.SOURCE]: event.source,
        [TELEMETRY_ATTRIBUTE.PRODUCT_VERSION]: productVersion,
        ...(event.failureCode
            ? { [TELEMETRY_ATTRIBUTE.FAILURE_CODE]: event.failureCode }
            : {}),
        ...(event.resourceKind
            ? { [TELEMETRY_ATTRIBUTE.RESOURCE_KIND]: event.resourceKind }
            : {}),
        ...(event.operation === TELEMETRY_OPERATION.FOUNDRY_SKILL_SYNC
            ? {
                [TELEMETRY_ATTRIBUTE.SKILL_ACTION]: event.skillAction,
                [TELEMETRY_ATTRIBUTE.PREVIOUS_STATUS]: event.previousStatus,
                [TELEMETRY_ATTRIBUTE.CHANGED]: event.changed,
                [TELEMETRY_ATTRIBUTE.READY]: event.ready,
                [TELEMETRY_ATTRIBUTE.RELOADED]: event.reloaded,
            }
            : {}),
    };
}

export function createTelemetryRecorder({
    productVersion = "",
    emitter,
    deviceId = Promise.resolve(null),
    os = platform(),
    architecture = arch(),
} = {}) {
    let cachedDeviceId =
        typeof deviceId === "string" ? deviceId.trim() : "";
    let deviceIdPromise = null;
    const resolveDeviceId = () => {
        if (cachedDeviceId) return Promise.resolve(cachedDeviceId);
        if (!deviceIdPromise) {
            deviceIdPromise = Promise.resolve()
                .then(() =>
                    typeof deviceId === "function" ? deviceId() : deviceId)
                .then((value) => {
                    const resolved =
                        typeof value === "string" ? value.trim() : "";
                    if (resolved) cachedDeviceId = resolved;
                    return resolved || null;
                })
                .catch(() => null)
                .finally(() => {
                    deviceIdPromise = null;
                });
        }
        return deviceIdPromise;
    };
    const safeEmit = (name, attributes, options) => {
        if (!emitter) return false;
        try {
            emitter.emit(name, attributes, options);
            return true;
        } catch {
            return false;
        }
    };
    const emitWithDeviceId = (name, attributes, options) => {
        if (!emitter) return false;
        if (cachedDeviceId) {
            return safeEmit(name, {
                [TELEMETRY_ATTRIBUTE.DEVICE_ID]: cachedDeviceId,
                ...attributes,
            }, options);
        }
        resolveDeviceId().then((resolvedDeviceId) => {
            safeEmit(name, {
                ...(resolvedDeviceId
                    ? { [TELEMETRY_ATTRIBUTE.DEVICE_ID]: resolvedDeviceId }
                    : {}),
                ...attributes,
            }, options);
        });
        return true;
    };

    return {
        enabled: !!emitter,
        recordActive() {
            return emitWithDeviceId(TELEMETRY_EVENT.ACTIVE, {
                [TELEMETRY_ATTRIBUTE.PRODUCT_VERSION]: productVersion,
                [TELEMETRY_ATTRIBUTE.OS]: os,
                [TELEMETRY_ATTRIBUTE.ARCHITECTURE]: architecture,
            });
        },
        recordAction(payload) {
            const event = validateActionPayload(payload);
            if (!event) return false;
            return emitWithDeviceId(TELEMETRY_EVENT.ACTION, {
                [TELEMETRY_ATTRIBUTE.ACTION]: event.action,
                [TELEMETRY_ATTRIBUTE.PRODUCT_VERSION]: productVersion,
                ...(event.resourceKind
                    ? { [TELEMETRY_ATTRIBUTE.RESOURCE_KIND]: event.resourceKind }
                    : {}),
            });
        },
        recordOperation(payload) {
            const event = validateOperationPayload(payload);
            if (!event) return false;
            return emitWithDeviceId(
                TELEMETRY_EVENT.OPERATION,
                operationAttributes(event, productVersion),
                {
                    failed: !TELEMETRY_SUCCESS_OUTCOMES.includes(event.outcome),
                },
            );
        },
        async shutdown() {
            try {
                await emitter?.shutdown?.();
            } catch {
                /* telemetry shutdown is best effort */
            }
        },
    };
}

export function createCanvasTelemetry({
    env = process.env,
    productVersion = "",
    bundledConnectionString = decodeBundledConnectionString(
        BUNDLED_CONNECTION_STRING_BASE64,
    ),
    getDeviceId = getOrCreateDeviceId,
    emitterFactory = createOtelEmitter,
} = {}) {
    const runtimeConnectionString =
        typeof env[TELEMETRY_CONNECTION_STRING_ENV] === "string"
            ? env[TELEMETRY_CONNECTION_STRING_ENV].trim()
            : "";
    const connectionString = runtimeConnectionString || bundledConnectionString;
    if (!connectionString) return createTelemetryRecorder({ productVersion });

    try {
        const emitter = emitterFactory({ connectionString, productVersion });
        const deviceId = () => Promise.resolve()
            .then(() => getDeviceId())
            .catch(() => null);
        return createTelemetryRecorder({ productVersion, emitter, deviceId });
    } catch {
        return createTelemetryRecorder({ productVersion });
    }
}

export const NOOP_TELEMETRY = createTelemetryRecorder();
