import {
    providerColor,
    selectModelPrompt,
    selectToolboxPrompt,
    selectGuardrailPrompt,
    selectSkillPrompt,
} from "./catalog.mjs";

export function slug(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function enrichDeployment(d) {
    return {
        id: d.name,
        name: d.name,
        provider: d.provider,
        version: d.version,
        color: providerColor(d.provider),
        prompt: selectModelPrompt(d.name),
    };
}

export function enrichToolbox(t) {
    return {
        id: slug(t.name),
        name: t.name,
        version: t.defaultVersion || "",
        prompt: selectToolboxPrompt(t.name),
    };
}

const GUARDRAIL_COLORS = { default: "#57606a", custom: "#0969da" };

export function enrichGuardrail(g) {
    const isDefault = g.name.startsWith("Microsoft.");
    return {
        id: slug(g.name),
        name: g.name,
        color: isDefault ? GUARDRAIL_COLORS.default : GUARDRAIL_COLORS.custom,
        prompt: selectGuardrailPrompt(g.name),
    };
}

export function enrichSkill(s) {
    return {
        id: slug(s.name),
        name: s.name,
        prompt: selectSkillPrompt(s.name),
    };
}
