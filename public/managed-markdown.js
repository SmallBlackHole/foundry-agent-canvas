import { lexer } from "./vendor/marked/marked.esm.js";

const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const CONTROL_OR_ENCODED_CONTROL = /[\u0000-\u001f\u007f]|%(?:0[0-9a-f]|1[0-9a-f]|7f)/i;

function textNode(value) {
    return { type: "text", value: String(value ?? "") };
}

function elementNode(tag, children = [], attributes = {}) {
    return { type: "element", tag, attributes, children };
}

function tokenText(token) {
    return token?.text ?? token?.raw ?? "";
}

export function safeMarkdownUrl(href, baseHref = "https://localhost/") {
    const value = String(href || "").trim();
    if (!value || CONTROL_OR_ENCODED_CONTROL.test(value)) return "";
    try {
        const resolved = new URL(value, baseHref);
        return ALLOWED_LINK_PROTOCOLS.has(resolved.protocol) ? resolved.href : "";
    } catch {
        return "";
    }
}

function renderInlineTokens(tokens, baseHref) {
    const nodes = [];
    for (const token of tokens || []) {
        switch (token.type) {
            case "text":
                nodes.push(...(
                    token.tokens
                        ? renderInlineTokens(token.tokens, baseHref)
                        : [textNode(token.text)]
                ));
                break;
            case "escape":
            case "html":
                nodes.push(textNode(tokenText(token)));
                break;
            case "strong":
                nodes.push(elementNode("strong", renderInlineTokens(token.tokens, baseHref)));
                break;
            case "em":
                nodes.push(elementNode("em", renderInlineTokens(token.tokens, baseHref)));
                break;
            case "del":
                nodes.push(elementNode("del", renderInlineTokens(token.tokens, baseHref)));
                break;
            case "codespan":
                nodes.push(elementNode("code", [textNode(token.text)]));
                break;
            case "br":
                nodes.push(elementNode("br"));
                break;
            case "link": {
                const children = renderInlineTokens(token.tokens, baseHref);
                const href = safeMarkdownUrl(token.href, baseHref);
                if (!href) {
                    nodes.push(...children);
                    break;
                }
                const attributes = {
                    href,
                    target: "_blank",
                    rel: "noopener noreferrer",
                };
                if (token.title) attributes.title = String(token.title);
                nodes.push(elementNode("a", children, attributes));
                break;
            }
            case "image":
                nodes.push(textNode(token.text ? `[image: ${token.text}]` : "[image]"));
                break;
            case "checkbox":
                nodes.push(textNode(token.checked ? "[x] " : "[ ] "));
                break;
            default:
                nodes.push(textNode(tokenText(token)));
                break;
        }
    }
    return nodes;
}

function renderListItem(item, baseHref) {
    const children = [];
    if (item.task) children.push(textNode(item.checked ? "[x] " : "[ ] "));
    for (const token of item.tokens || []) {
        if (token.type === "text") {
            children.push(...renderInlineTokens(token.tokens || [token], baseHref));
        } else {
            children.push(...renderBlockToken(token, baseHref));
        }
    }
    return elementNode("li", children);
}

function renderTableCell(tag, cell, baseHref) {
    const attributes = {};
    if (["left", "center", "right"].includes(cell.align)) {
        attributes.class = `is-${cell.align}`;
    }
    return elementNode(tag, renderInlineTokens(cell.tokens, baseHref), attributes);
}

function renderBlockToken(token, baseHref) {
    switch (token.type) {
        case "space":
        case "def":
            return [];
        case "paragraph":
            return [elementNode("p", renderInlineTokens(token.tokens, baseHref))];
        case "text":
            return [elementNode("p", renderInlineTokens(token.tokens || [token], baseHref))];
        case "heading": {
            const depth = Math.min(6, Math.max(1, Number(token.depth) || 1));
            return [elementNode(`h${depth}`, renderInlineTokens(token.tokens, baseHref))];
        }
        case "code":
            return [elementNode("pre", [elementNode("code", [textNode(token.text)])])];
        case "blockquote":
            return [elementNode("blockquote", renderBlockTokens(token.tokens, baseHref))];
        case "list": {
            const attributes = {};
            if (token.ordered && Number.isInteger(token.start) && token.start !== 1) {
                attributes.start = String(token.start);
            }
            return [elementNode(
                token.ordered ? "ol" : "ul",
                (token.items || []).map((item) => renderListItem(item, baseHref)),
                attributes,
            )];
        }
        case "table": {
            const header = elementNode(
                "thead",
                [elementNode(
                    "tr",
                    (token.header || []).map((cell) => renderTableCell("th", cell, baseHref)),
                )],
            );
            const body = elementNode(
                "tbody",
                (token.rows || []).map((row) => elementNode(
                    "tr",
                    row.map((cell) => renderTableCell("td", cell, baseHref)),
                )),
            );
            return [elementNode(
                "div",
                [elementNode("table", [header, body])],
                { class: "managed-markdown-table-wrap" },
            )];
        }
        case "hr":
            return [elementNode("hr")];
        case "html":
            return [elementNode("p", [textNode(tokenText(token))])];
        default:
            return [elementNode("p", [textNode(tokenText(token))])];
    }
}

function renderBlockTokens(tokens, baseHref) {
    return (tokens || []).flatMap((token) => renderBlockToken(token, baseHref));
}

export function markdownToSafeNodes(source, baseHref = "https://localhost/") {
    const text = String(source ?? "");
    try {
        return renderBlockTokens(lexer(text, { gfm: true, breaks: false }), baseHref);
    } catch {
        return [textNode(text)];
    }
}

function createDomNode(document, node) {
    if (node.type === "text") return document.createTextNode(node.value);
    const element = document.createElement(node.tag);
    for (const [name, value] of Object.entries(node.attributes || {})) {
        element.setAttribute(name, value);
    }
    element.append(...node.children.map((child) => createDomNode(document, child)));
    return element;
}

export function renderManagedAssistantMarkdown(target, source) {
    const document = target.ownerDocument;
    try {
        const nodes = markdownToSafeNodes(source, document.baseURI);
        target.replaceChildren(...nodes.map((node) => createDomNode(document, node)));
    } catch {
        target.textContent = String(source ?? "");
    }
}
