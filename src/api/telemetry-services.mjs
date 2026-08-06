export function createTelemetryServices({ telemetry }) {
    return {
        recordTelemetryAction({ body }) {
            telemetry?.recordAction?.(body);
            return { ok: true };
        },
    };
}
