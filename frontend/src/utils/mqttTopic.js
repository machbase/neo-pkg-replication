const ALLOWED = /^[A-Za-z0-9._\-/]+$/;
const MAX_BYTES = 65535;

export function validateMqttTopic(topic) {
    if (typeof topic !== "string" || topic.length === 0) {
        return { valid: false, error: "Topic must not be empty." };
    }
    if (topic.trim() !== topic) {
        return { valid: false, error: "Topic must not have leading or trailing whitespace." };
    }
    if (topic.includes("\0")) {
        return { valid: false, error: "Topic must not contain a null character." };
    }
    if (/\s/.test(topic)) {
        return { valid: false, error: "Topic must not contain whitespace characters." };
    }
    if (topic.startsWith("$")) {
        return { valid: false, error: "Topic must not start with '$'." };
    }
    if (/[+#]/.test(topic)) {
        return { valid: false, error: "Topic must not contain '+' or '#'." };
    }
    if (topic.startsWith("/") || topic.endsWith("/")) {
        return { valid: false, error: "Topic must not start or end with '/'." };
    }
    if (topic.includes("//")) {
        return { valid: false, error: "Topic must not contain '//'." };
    }
    if (!ALLOWED.test(topic)) {
        return {
            valid: false,
            error: "Topic contains disallowed characters. (Allowed: letters, digits, '.', '_', '-', '/')",
        };
    }
    const bytes = new TextEncoder().encode(topic).byteLength;
    if (bytes > MAX_BYTES) {
        return { valid: false, error: `Topic must not exceed ${MAX_BYTES} bytes (UTF-8).` };
    }
    return { valid: true, error: null };
}
