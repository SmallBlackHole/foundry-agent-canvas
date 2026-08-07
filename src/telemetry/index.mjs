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
    TELEMETRY_CONNECTION_STRING_ENV,
    TELEMETRY_EVENTS,
    TELEMETRY_SERVICE_NAME,
    validateActionPayload,
    validateOperationPayload,
} from "./schema.mjs";

const PRODUCT_VERSION = "ftk.canvas.productVersion";
const BUNDLED_CONNECTION_STRING_BASE64 =
    typeof __FOUNDRY_CANVAS_APPINSIGHTS_CONNECTION_STRING_BASE64__ === "string"
        ? __FOUNDRY_CANVAS_APPINSIGHTS_CONNECTION_STRING_BASE64__
        : "";
const TEMPORARY_EXPORTER_ENV = {
    APPLICATION_INSIGHTS_NO_STATSBEAT: "1",
    APPLICATIONINSIGHTS_OPENTELEMETRY_RESOURCE_METRIC_DISABLED: "true",
};

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
    const exporter = withTemporaryEnvironment(TEMPORARY_EXPORTER_ENV, () =>
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
        "ftk.canvas.operation": event.operation,
        "ftk.canvas.outcome": event.outcome,
        "ftk.canvas.durationMs": event.durationMs,
        "ftk.canvas.source": event.source,
        [PRODUCT_VERSION]: productVersion,
        ...(event.failureCode
            ? { "ftk.canvas.failureCode": event.failureCode }
            : {}),
        ...(event.resourceKind
            ? { "ftk.canvas.resourceKind": event.resourceKind }
            : {}),
        ...(event.operation === "foundry_skill_sync"
            ? {
                "ftk.canvas.skillAction": event.skillAction,
                "ftk.canvas.previousStatus": event.previousStatus,
                "ftk.canvas.changed": event.changed,
                "ftk.canvas.ready": event.ready,
                "ftk.canvas.reloaded": event.reloaded,
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
    let deviceIdPromise = null;
    const resolveDeviceId = () => {
        if (!deviceIdPromise) {
            deviceIdPromise = Promise.resolve(
                typeof deviceId === "function" ? deviceId() : deviceId,
            );
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

    return {
        enabled: !!emitter,
        recordActive() {
            if (!emitter) return false;
            resolveDeviceId()
                .then((resolvedDeviceId) => {
                    safeEmit(TELEMETRY_EVENTS.active, {
                        ...(resolvedDeviceId
                            ? { "ftk.canvas.devDeviceId": resolvedDeviceId }
                            : {}),
                        [PRODUCT_VERSION]: productVersion,
                        "ftk.canvas.os": os,
                        "ftk.canvas.arch": architecture,
                    });
                })
                .catch(() => {
                    safeEmit(TELEMETRY_EVENTS.active, {
                        [PRODUCT_VERSION]: productVersion,
                        "ftk.canvas.os": os,
                        "ftk.canvas.arch": architecture,
                    });
                });
            return true;
        },
        recordAction(payload) {
            const event = validateActionPayload(payload);
            if (!event) return false;
            return safeEmit(TELEMETRY_EVENTS.action, {
                "ftk.canvas.action": event.action,
                [PRODUCT_VERSION]: productVersion,
                ...(event.resourceKind
                    ? { "ftk.canvas.resourceKind": event.resourceKind }
                    : {}),
            });
        },
        recordOperation(payload) {
            const event = validateOperationPayload(payload);
            if (!event) return false;
            return safeEmit(
                TELEMETRY_EVENTS.operation,
                operationAttributes(event, productVersion),
                {
                    failed: event.outcome === "failed"
                        || event.outcome === "timed_out",
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
